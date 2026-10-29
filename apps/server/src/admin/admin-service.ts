import type { FastifyBaseLogger } from 'fastify';
import type { Role } from '../auth/tokens.js';
import type { Clock } from '../clock.js';
import { withTransaction, type Db, type Tx } from '../db/tx.js';
import { conflict, notFound } from '../errors.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import type { RoomsService } from '../lobby/rooms-service.js';
import type { MatchOrigin, MatchStore } from '../matches/match-store.js';
import type { EventBus } from '../realtime/bus.js';
import type { Presence } from '../realtime/presence.js';
import { writeAudit, type AuditAction, type AuditContext, type AuditTarget } from './audit.js';

/** Una partida en curso vista por un administrador: solo datos públicos, nunca manos ni límite. */
export interface AdminMatch {
  readonly matchId: string;
  readonly origin: MatchOrigin;
  readonly seq: number;
  readonly turn: number;
  readonly currentPlayer: string | null;
  readonly turnDeadline: string | null;
  readonly createdAt: string;
  readonly players: {
    readonly id: string;
    readonly displayName: string;
    /** `false` si ya quedó eliminado. */
    readonly inGame: boolean;
    readonly connections: number;
    readonly disconnectedAt: string | null;
  }[];
}

export interface ConnectionsOverview {
  readonly total: number;
  /** `true` si hay más conexiones de las que se listan. */
  readonly truncated: boolean;
  readonly replicas: { readonly replica: string; readonly connections: number }[];
  readonly users: {
    readonly userId: string;
    readonly displayName: string;
    readonly connections: number;
    readonly activeMatchId: string | null;
  }[];
}

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly suspendedAt: string | null;
  readonly activeMatchId: string | null;
  readonly connections: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly actor: { readonly id: string; readonly displayName: string } | null;
  readonly action: AuditAction;
  readonly targetType: AuditTarget;
  readonly targetId: string;
  readonly reason: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly createdAt: string;
}

export interface TerminatedMatch {
  readonly matchId: string;
  readonly seq: number;
  readonly status: 'aborted';
}

/** Cuántas conexiones como máximo se listan en la vista de conexiones. */
const CONNECTIONS_LIMIT = 1000;

export interface AdminServiceDeps {
  readonly db: Db;
  readonly store: MatchStore;
  readonly rooms: Pick<RoomsService, 'removeFromAnyRoom'>;
  readonly presence: Presence;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
}

/**
 * Funciones del rol administrador. Cada acción que cambia algo escribe su fila de auditoría
 * en la misma transacción. Las lecturas no exponen información oculta de ninguna partida.
 */
export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  // --- Lecturas --------------------------------------------------------------------------------

  async activeMatches(query: { limit: number; cursor?: string | undefined }): Promise<Page<AdminMatch>> {
    const cursor = decodeCursor(query.cursor);
    const { rows } = await this.deps.db.query<{
      id: string;
      origin: MatchOrigin;
      seq: number;
      turn: number;
      current_player: string | null;
      turn_deadline: Date | null;
      created_at: Date;
      players: { id: string; displayName: string; active: boolean; disconnectedAt: string | null }[];
    }>(
      `SELECT m.id, m.origin, m.seq, m.turn, m.current_player, m.turn_deadline, m.created_at,
              (SELECT json_agg(json_build_object('id', u.id, 'displayName', u.display_name, 'active', p.active,
                                                 'disconnectedAt', p.disconnected_at) ORDER BY u.display_name)
                 FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = m.id) AS players
         FROM matches m
        WHERE m.status = 'playing'
          AND ($1::timestamptz IS NULL OR (m.created_at, m.id) < ($1::timestamptz, $2::uuid))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $3`,
      [cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const live = await this.deps.presence.liveConnections([
      ...new Set(rows.flatMap((r) => r.players.map((p) => p.id))),
    ]);
    return toPage(
      rows,
      query.limit,
      (r) => ({
        matchId: r.id,
        origin: r.origin,
        seq: r.seq,
        turn: r.turn,
        currentPlayer: r.current_player,
        turnDeadline: r.turn_deadline?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        players: r.players.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          inGame: p.active,
          connections: live.get(p.id) ?? 0,
          disconnectedAt: p.disconnectedAt === null ? null : new Date(p.disconnectedAt).toISOString(),
        })),
      }),
      (r) => ({ at: r.created_at, id: r.id }),
    );
  }

  /** Conexiones abiertas en todas las réplicas, agrupadas por réplica y por usuario. */
  async connections(): Promise<ConnectionsOverview> {
    const { total, connections } = await this.deps.presence.listAll(CONNECTIONS_LIMIT);
    const byReplica = new Map<string, number>();
    const byUser = new Map<string, number>();
    for (const c of connections) {
      byReplica.set(c.replica, (byReplica.get(c.replica) ?? 0) + 1);
      byUser.set(c.userId, (byUser.get(c.userId) ?? 0) + 1);
    }
    const { rows } = await this.deps.db.query<{ id: string; display_name: string; match_id: string | null }>(
      `SELECT u.id, u.display_name,
              (SELECT p.match_id FROM match_players p WHERE p.user_id = u.id AND p.active LIMIT 1) AS match_id
         FROM users u WHERE u.id = ANY($1::uuid[])`,
      [[...byUser.keys()]],
    );
    const users = rows
      .map((r) => ({
        userId: r.id,
        displayName: r.display_name,
        connections: byUser.get(r.id) ?? 0,
        activeMatchId: r.match_id,
      }))
      .sort((a, b) => b.connections - a.connections || a.displayName.localeCompare(b.displayName));
    return {
      total,
      truncated: total > connections.length,
      replicas: [...byReplica]
        .map(([replica, count]) => ({ replica, connections: count }))
        .sort((a, b) => a.replica.localeCompare(b.replica)),
      users,
    };
  }

  async user(userId: string): Promise<AdminUser> {
    const { rows } = await this.deps.db.query<{
      id: string;
      email: string;
      display_name: string;
      role: Role;
      created_at: Date;
      suspended_at: Date | null;
      match_id: string | null;
    }>(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.suspended_at,
              (SELECT p.match_id FROM match_players p WHERE p.user_id = u.id AND p.active LIMIT 1) AS match_id
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (row === undefined) throw notFound('El usuario');
    const live = await this.deps.presence.liveConnections([userId]);
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at.toISOString(),
      suspendedAt: row.suspended_at?.toISOString() ?? null,
      activeMatchId: row.match_id,
      connections: live.get(userId) ?? 0,
    };
  }

  /** Registro de auditoría, del más nuevo al más viejo. Se puede filtrar por la partida o el usuario afectado. */
  async audit(query: {
    limit: number;
    cursor?: string | undefined;
    targetId?: string | undefined;
  }): Promise<Page<AuditEntry>> {
    const cursor = decodeCursor(query.cursor);
    const { rows } = await this.deps.db.query<{
      id: string;
      actor_id: string | null;
      actor_name: string | null;
      action: AuditAction;
      target_type: AuditTarget;
      target_id: string;
      reason: string;
      details: Record<string, unknown>;
      request_id: string | null;
      created_at: Date;
    }>(
      `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.target_type, a.target_id, a.reason,
              a.details, a.request_id, a.created_at
         FROM admin_audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::uuid IS NULL OR a.target_id = $1)
          AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [query.targetId ?? null, cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    return toPage(
      rows,
      query.limit,
      (r) => ({
        id: r.id,
        actor: r.actor_id === null ? null : { id: r.actor_id, displayName: r.actor_name ?? '' },
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        details: r.details,
        requestId: r.request_id,
        createdAt: r.created_at.toISOString(),
      }),
      (r) => ({ at: r.created_at, id: r.id }),
    );
  }

  // --- Acciones --------------------------------------------------------------------------------

  /**
   * Termina una partida en curso. Pasa por el dominio como cualquier jugada: queda un evento
   * `MatchEnded` (resultado `aborted`) en la historia, los jugadores conectados lo reciben por
   * WebSocket y quedan libres para jugar otra.
   */
  async terminateMatch(matchId: string, ctx: AuditContext): Promise<TerminatedMatch> {
    const result = await this.deps.store.apply(
      matchId,
      { type: 'terminate' },
      {
        withinTransaction: (tx, applied) =>
          writeAudit(
            tx,
            {
              action: 'match.terminate',
              targetType: 'match',
              targetId: matchId,
              details: { seq: applied.seq, players: applied.state.players.map((p) => p.id) },
            },
            ctx,
          ),
      },
    );
    switch (result.kind) {
      case 'applied':
        return { matchId, seq: result.seq, status: 'aborted' };
      case 'duplicate':
        throw new Error('terminate no usa moveId');
      case 'rejected':
        if (result.code === 'MATCH_NOT_FOUND') throw notFound('La partida');
        if (result.code === 'MATCH_FINISHED') throw conflict('MATCH_FINISHED', 'La partida ya terminó');
        throw conflict(result.code, result.message);
    }
  }

  /**
   * Suspende una cuenta. En una transacción: la marca, revoca sus sesiones, la saca de la cola
   * y de su sala, y audita. Ya confirmado: abandona su partida en curso (las demás siguen sin
   * esperar el periodo de gracia) y cierra sus conexiones en todas las réplicas.
   */
  async suspendUser(userId: string, ctx: AuditContext): Promise<AdminUser> {
    if (ctx.actorId === userId) throw conflict('CANNOT_SUSPEND_SELF', 'No puedes suspender tu propia cuenta');
    await withTransaction(this.deps.db, async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (user.suspended_at !== null) throw conflict('ALREADY_SUSPENDED', 'La cuenta ya está suspendida');
      const now = this.deps.clock.now();
      await tx.query('UPDATE users SET suspended_at = $2 WHERE id = $1', [userId, now]);
      const revoked = await tx.query<{ family_id: string }>(
        'UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING family_id',
        [userId, now],
      );
      const dequeued = await tx.query("DELETE FROM matchmaking_tickets WHERE user_id = $1 AND status = 'waiting'", [
        userId,
      ]);
      const leftRoomId = await this.deps.rooms.removeFromAnyRoom(tx, userId);
      const active = await tx.query<{ match_id: string }>(
        'SELECT match_id FROM match_players WHERE user_id = $1 AND active',
        [userId],
      );
      await writeAudit(
        tx,
        {
          action: 'user.suspend',
          targetType: 'user',
          targetId: userId,
          details: {
            revokedSessions: new Set(revoked.rows.map((r) => r.family_id)).size,
            dequeued: dequeued.rowCount === 1,
            leftRoomId,
            activeMatchId: active.rows[0]?.match_id ?? null,
          },
        },
        ctx,
      );
    });

    // Se vuelve a buscar la partida después de confirmar: así también se cubre una que se haya
    // creado mientras tanto (una sala que arrancó justo antes de la suspensión).
    const { rows } = await this.deps.db.query<{ match_id: string }>(
      'SELECT match_id FROM match_players WHERE user_id = $1 AND active',
      [userId],
    );
    for (const { match_id: matchId } of rows) {
      try {
        await this.deps.store.apply(matchId, { type: 'abandon', playerId: userId });
      } catch (err) {
        // Si falla, el periodo de gracia lo resuelve: con la cuenta suspendida no puede reconectar.
        this.deps.log.warn({ err, matchId, userId }, 'no se pudo aplicar el abandono al suspender');
      }
    }
    await this.deps.bus.userSuspended(userId);
    return this.user(userId);
  }

  async reinstateUser(userId: string, ctx: AuditContext): Promise<AdminUser> {
    await withTransaction(this.deps.db, async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (user.suspended_at === null) throw conflict('NOT_SUSPENDED', 'La cuenta no está suspendida');
      await tx.query('UPDATE users SET suspended_at = NULL WHERE id = $1', [userId]);
      await writeAudit(
        tx,
        {
          action: 'user.reinstate',
          targetType: 'user',
          targetId: userId,
          details: { suspendedAt: user.suspended_at.toISOString() },
        },
        ctx,
      );
    });
    return this.user(userId);
  }

  /**
   * Bloquea la fila del usuario. `FOR NO KEY UPDATE` y no `FOR UPDATE`: así no choca con las
   * claves foráneas que la referencian (una sala que arranca y crea la partida en paralelo).
   */
  private async lockUser(tx: Tx, userId: string): Promise<{ suspended_at: Date | null }> {
    const { rows } = await tx.query<{ suspended_at: Date | null }>(
      'SELECT suspended_at FROM users WHERE id = $1 FOR NO KEY UPDATE',
      [userId],
    );
    const user = rows[0];
    if (user === undefined) throw notFound('El usuario');
    return user;
  }
}
