import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION, withTransaction, type Db } from '../db/tx.js';
import { AppError, conflict, notFound, unauthorized } from '../errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { hashRefreshToken, newRefreshToken, type Role, type TokenIssuer } from './tokens.js';

export interface Profile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly createdAt: string;
}

export interface Session {
  readonly user: Profile;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  suspended_at: Date | null;
  created_at: Date;
}

const toProfile = (row: UserRow): Profile => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  createdAt: row.created_at.toISOString(),
});

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface AuthServiceDeps {
  readonly db: Db;
  readonly tokens: TokenIssuer;
  readonly clock: Clock;
  readonly refreshTtlSeconds: number;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(input: { email: string; password: string; displayName: string }): Promise<Session> {
    const passwordHash = await hashPassword(input.password);
    try {
      const { rows } = await this.deps.db.query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
        [normalizeEmail(input.email), input.displayName.trim(), passwordHash],
      );
      const user = rows[0];
      if (user === undefined) throw new Error('INSERT sin filas');
      return await this.startSession(user, randomUUID());
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw conflict('EMAIL_TAKEN', 'Ya existe una cuenta con ese correo');
      }
      throw error;
    }
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    const { rows } = await this.deps.db.query<UserRow>('SELECT * FROM users WHERE email = $1', [
      normalizeEmail(input.email),
    ]);
    const user = rows[0];
    const valid =
      user === undefined
        ? await verifyAgainstDummy(input.password)
        : await verifyPassword(user.password_hash, input.password);
    if (user === undefined || !valid) throw unauthorized();
    if (user.suspended_at !== null) throw new AppError('forbidden', 'La cuenta está suspendida', 'ACCOUNT_SUSPENDED');
    return this.startSession(user, randomUUID());
  }

  /**
   * Rota el refresh token: el usado queda marcado y se entrega uno nuevo de la misma familia.
   * Si llega un token ya usado (posible robo), se revoca toda la familia.
   */
  async refresh(refreshToken: string): Promise<Session> {
    const now = this.deps.clock.now();
    const outcome = await withTransaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        family_id: string;
        expires_at: Date;
        used_at: Date | null;
        revoked_at: Date | null;
      }>(
        'SELECT id, user_id, family_id, expires_at, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [hashRefreshToken(refreshToken)],
      );
      const token = rows[0];
      if (token === undefined || token.revoked_at !== null || token.expires_at <= now)
        return { kind: 'invalid' } as const;
      if (token.used_at !== null) {
        await tx.query('UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL', [
          token.family_id,
          now,
        ]);
        return { kind: 'reused' } as const;
      }
      await tx.query('UPDATE refresh_tokens SET used_at = $2 WHERE id = $1', [token.id, now]);
      const user = await tx.query<UserRow>('SELECT * FROM users WHERE id = $1', [token.user_id]);
      const row = user.rows[0];
      if (row === undefined || row.suspended_at !== null) return { kind: 'invalid' } as const;
      const session = await this.startSession(row, token.family_id, tx);
      return { kind: 'ok', session } as const;
    });
    if (outcome.kind !== 'ok') {
      throw unauthorized(
        outcome.kind === 'reused'
          ? 'El refresh token ya se había usado; la sesión se cerró'
          : 'Refresh token inválido o vencido',
      );
    }
    return outcome.session;
  }

  /** Cierra la sesión: revoca toda la familia del refresh token. No revela si existía. */
  async logout(refreshToken: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE refresh_tokens SET revoked_at = $2
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [hashRefreshToken(refreshToken), this.deps.clock.now()],
    );
  }

  async profile(userId: string): Promise<Profile> {
    const { rows } = await this.deps.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (user === undefined) throw notFound('El usuario');
    return toProfile(user);
  }

  async updateProfile(userId: string, input: { displayName: string }): Promise<Profile> {
    const { rows } = await this.deps.db.query<UserRow>('UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [
      userId,
      input.displayName.trim(),
    ]);
    const user = rows[0];
    if (user === undefined) throw notFound('El usuario');
    return toProfile(user);
  }

  /** Estado actual del usuario para la guardia de autenticación (suspensión inmediata). */
  async accountStatus(userId: string): Promise<{ role: Role; suspended: boolean } | null> {
    const { rows } = await this.deps.db.query<{ role: Role; suspended_at: Date | null }>(
      'SELECT role, suspended_at FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    return row === undefined ? null : { role: row.role, suspended: row.suspended_at !== null };
  }

  private async startSession(user: UserRow, familyId: string, tx?: { query: Db['query'] }): Promise<Session> {
    const { token, hash } = newRefreshToken();
    const expiresAt = new Date(this.deps.clock.now().getTime() + this.deps.refreshTtlSeconds * 1000);
    await (tx ?? this.deps.db).query(
      'INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, familyId, hash, expiresAt],
    );
    const accessToken = await this.deps.tokens.signAccess({ userId: user.id, role: user.role });
    return {
      user: toProfile(user),
      accessToken,
      refreshToken: token,
      tokenType: 'Bearer',
      expiresIn: this.deps.tokens.accessTtlSeconds,
    };
  }
}
