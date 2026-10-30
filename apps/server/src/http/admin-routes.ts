import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AdminService } from '../admin/admin-service.js';
import type { AuditContext } from '../admin/audit.js';
import type { AuthService } from '../auth/auth-service.js';
import type { TokenIssuer } from '../auth/tokens.js';
import { currentUser, requireAdmin } from './auth-guard.js';
import { bearer, perUser } from './route-config.js';
import * as S from './schemas.js';

interface AdminDeps {
  readonly admin: AdminService;
  readonly auth: AuthService;
  readonly tokens: TokenIssuer;
}

const tags = ['Administración'];

/** Quién, por qué y en qué solicitud: lo que queda en la fila de auditoría. */
const auditContext = (request: FastifyRequest, reason: string): AuditContext => ({
  actorId: currentUser(request).id,
  reason,
  requestId: request.id,
});

/**
 * Rutas del rol administrador. La guardia revisa el rol en la base en cada solicitud; cada
 * acción que cambia algo queda en la auditoría y además en el log, sin el motivo (puede traer
 * datos personales) pero con el ID de la solicitud para cruzarlos.
 */
export function registerAdminRoutes(root: FastifyInstance, services: AdminDeps, perMinute: number): void {
  const app = root.withTypeProvider<ZodTypeProvider>();
  const admin = requireAdmin(services.tokens, services.auth);
  const limit = perUser(perMinute);

  app.get('/v1/admin/matches', {
    schema: {
      tags,
      summary: 'Partidas en curso',
      description: 'De la más nueva a la más vieja, con el estado de conexión de cada jugador.',
      security: bearer,
      querystring: S.PageQuery,
      response: { 200: S.AdminMatchPage, ...S.errors(400, 401, 403, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: (request) => services.admin.activeMatches(request.query),
  });

  app.post('/v1/admin/matches/:id/terminate', {
    schema: {
      tags,
      summary: 'Terminar una partida',
      description:
        'La partida termina sin ganador (resultado `aborted`). Los jugadores conectados reciben el evento `MatchEnded` por WebSocket y quedan libres para jugar otra.',
      security: bearer,
      params: S.IdParams,
      body: S.AdminActionBody,
      response: { 200: S.TerminatedMatch, ...S.errors(400, 401, 403, 404, 409, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: async (request) => {
      const result = await services.admin.terminateMatch(request.params.id, auditContext(request, request.body.reason));
      request.log.info({ action: 'match.terminate', matchId: request.params.id }, 'acción de administración');
      return result;
    },
  });

  app.get('/v1/admin/connections', {
    schema: {
      tags,
      summary: 'Conexiones abiertas',
      description: 'Conexiones WebSocket de todas las réplicas, agrupadas por réplica y por usuario.',
      security: bearer,
      response: { 200: S.ConnectionsOverview, ...S.errors(401, 403, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: () => services.admin.connections(),
  });

  app.get('/v1/admin/users/:id', {
    schema: {
      tags,
      summary: 'Ver un usuario',
      security: bearer,
      params: S.IdParams,
      response: { 200: S.AdminUser, ...S.errors(400, 401, 403, 404, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: (request) => services.admin.user(request.params.id),
  });

  app.post('/v1/admin/users/:id/suspend', {
    schema: {
      tags,
      summary: 'Suspender un usuario',
      description:
        'Aplica de inmediato: se revocan sus sesiones, sale de la cola y de su sala, abandona la partida en curso y sus conexiones se cierran con 4003 en todas las réplicas.',
      security: bearer,
      params: S.IdParams,
      body: S.AdminActionBody,
      response: { 200: S.AdminUser, ...S.errors(400, 401, 403, 404, 409, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: async (request) => {
      const user = await services.admin.suspendUser(request.params.id, auditContext(request, request.body.reason));
      request.log.info({ action: 'user.suspend', targetUserId: request.params.id }, 'acción de administración');
      return user;
    },
  });

  app.post('/v1/admin/users/:id/reinstate', {
    schema: {
      tags,
      summary: 'Quitar la suspensión',
      security: bearer,
      params: S.IdParams,
      body: S.AdminActionBody,
      response: { 200: S.AdminUser, ...S.errors(400, 401, 403, 404, 409, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: async (request) => {
      const user = await services.admin.reinstateUser(request.params.id, auditContext(request, request.body.reason));
      request.log.info({ action: 'user.reinstate', targetUserId: request.params.id }, 'acción de administración');
      return user;
    },
  });

  app.get('/v1/admin/audit', {
    schema: {
      tags,
      summary: 'Registro de auditoría',
      description:
        'Todas las acciones de administración, de la más nueva a la más vieja. No se puede editar ni borrar.',
      security: bearer,
      querystring: S.AuditQuery,
      response: { 200: S.AuditPage, ...S.errors(400, 401, 403, 429) },
    },
    config: limit,
    preHandler: admin,
    handler: (request) => services.admin.audit(request.query),
  });
}
