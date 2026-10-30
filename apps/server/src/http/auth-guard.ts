import type { FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/auth-service.js';
import { InvalidTokenError, type Role, type TokenIssuer } from '../auth/tokens.js';
import { AppError, unauthorized } from '../errors.js';

export interface AuthUser {
  readonly id: string;
  readonly role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

/**
 * Exige un access token válido. Además del JWT, consulta la cuenta en la base: así una
 * suspensión o un cambio de rol aplican de inmediato y no hasta que venza el token.
 */
export function requireAuth(tokens: TokenIssuer, auth: Pick<AuthService, 'accountStatus'>) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    const token = match?.[1];
    if (token === undefined) throw unauthorized('Falta el access token (Authorization: Bearer)');

    let claims;
    try {
      claims = await tokens.verifyAccess(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw unauthorized('El access token no es válido o venció');
      throw error;
    }

    const account = await auth.accountStatus(claims.userId);
    if (account === null) throw unauthorized('La cuenta ya no existe');
    if (account.suspended) throw new AppError('forbidden', 'La cuenta está suspendida', 'ACCOUNT_SUSPENDED');
    request.authUser = { id: claims.userId, role: account.role };
  };
}

/**
 * Exige un usuario autenticado con rol de administrador. El rol se lee de la base en cada
 * solicitud (no del JWT): quitarle el rol a alguien aplica de inmediato.
 */
export function requireAdmin(tokens: TokenIssuer, auth: Pick<AuthService, 'accountStatus'>) {
  const authenticate = requireAuth(tokens, auth);
  return async (request: FastifyRequest): Promise<void> => {
    await authenticate(request);
    if (request.authUser?.role !== 'admin') {
      request.log.warn({ userId: request.authUser?.id }, 'intento de usar administración sin el rol');
      throw new AppError('forbidden', 'Solo un administrador puede usar esta función', 'ADMIN_ONLY');
    }
    request.log.info({ adminId: request.authUser.id, route: request.routeOptions.url }, 'acceso de administración');
  };
}

/** El usuario autenticado; solo se usa en rutas protegidas por `requireAuth`. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (request.authUser === null) throw unauthorized();
  return request.authUser;
}
