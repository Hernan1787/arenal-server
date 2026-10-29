import { PlayerEventSchema, PlayerViewSchema } from '@arenal/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import type { TokenIssuer } from '../auth/tokens.js';
import type { MatchmakingService } from '../lobby/matchmaking-service.js';
import type { RoomsService } from '../lobby/rooms-service.js';
import type { MatchesService } from '../matches/matches-service.js';
import { REALTIME_PATH } from '../realtime/gateway.js';
import type { TicketStore } from '../realtime/tickets.js';
import { currentUser, requireAuth } from './auth-guard.js';
import * as S from './schemas.js';

export interface ApiServices {
  readonly auth: AuthService;
  readonly tokens: TokenIssuer;
  readonly rooms: RoomsService;
  readonly matchmaking: MatchmakingService;
  readonly matches: MatchesService;
  readonly tickets: TicketStore;
}

const bearer = [{ bearerAuth: [] }];

export interface RateLimits {
  /** Registro, login y unión por código, por IP. */
  readonly authPerMinute: number;
  /** Tickets de WebSocket, por usuario. */
  readonly ticketsPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { authPerMinute: 10, ticketsPerMinute: 30 };

/** Rutas de la API v1. Todo lo que no es tiempo real pasa por aquí. */
export function registerApiRoutes(
  root: FastifyInstance,
  services: ApiServices,
  limits: RateLimits = DEFAULT_RATE_LIMITS,
): void {
  const app = root.withTypeProvider<ZodTypeProvider>();
  const auth = requireAuth(services.tokens, services.auth);
  const perIp = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  // En rutas autenticadas el límite va por usuario y se evalúa después de la guardia: muchos
  // jugadores detrás de la misma IP (una red universitaria, la prueba de carga) no se bloquean entre sí.
  const perUser = (max: number) => ({
    rateLimit: {
      max,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => request.authUser?.id ?? request.ip,
    },
  });

  // --- Usuarios ----------------------------------------------------------------------------

  app.post('/v1/auth/register', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Crear una cuenta',
      body: S.RegisterBody,
      response: { 201: S.Session, ...S.errors(400, 409, 429) },
    },
    config: perIp(limits.authPerMinute),
    handler: async (request, reply) => reply.code(201).send(await services.auth.register(request.body)),
  });

  app.post('/v1/auth/login', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Iniciar sesión',
      body: S.LoginBody,
      response: { 200: S.Session, ...S.errors(400, 401, 403, 429) },
    },
    config: perIp(limits.authPerMinute),
    handler: (request) => services.auth.login(request.body),
  });

  app.post('/v1/auth/refresh', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Renovar el access token',
      description:
        'Entrega un access token y un refresh token nuevos. El refresh token usado deja de servir; si alguien lo vuelve a usar, se cierra toda la sesión.',
      body: S.RefreshBody,
      response: { 200: S.Session, ...S.errors(400, 401, 429) },
    },
    config: perIp(limits.authPerMinute * 3),
    handler: (request) => services.auth.refresh(request.body.refreshToken),
  });

  app.post('/v1/auth/logout', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Cerrar sesión',
      body: S.RefreshBody,
      response: { 204: z.null().describe('Sesión cerrada'), ...S.errors(400) },
    },
    handler: async (request, reply) => {
      await services.auth.logout(request.body.refreshToken);
      return reply.code(204).send(null);
    },
  });

  app.get('/v1/me', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Ver mi perfil',
      security: bearer,
      response: { 200: S.Profile, ...S.errors(401, 403) },
    },
    preHandler: auth,
    handler: (request) => services.auth.profile(currentUser(request).id),
  });

  app.patch('/v1/me', {
    schema: {
      tags: ['Usuarios'],
      summary: 'Cambiar mi nombre visible',
      security: bearer,
      body: S.UpdateProfileBody,
      response: { 200: S.Profile, ...S.errors(400, 401, 403) },
    },
    preHandler: auth,
    handler: (request) => services.auth.updateProfile(currentUser(request).id, request.body),
  });

  app.get('/v1/me/matches', {
    schema: {
      tags: ['Historial'],
      summary: 'Mis partidas',
      description: 'Partidas en las que participé, de la más nueva a la más vieja.',
      security: bearer,
      querystring: S.PageQuery,
      response: { 200: S.MatchPage, ...S.errors(400, 401, 403) },
    },
    preHandler: auth,
    handler: (request) => services.matches.history(currentUser(request).id, request.query),
  });

  // --- Salas -------------------------------------------------------------------------------

  app.post('/v1/rooms', {
    schema: {
      tags: ['Salas'],
      summary: 'Crear una sala',
      description: 'Quien la crea entra como anfitrión. Una sala privada trae un código de invitación de 8 caracteres.',
      security: bearer,
      body: S.CreateRoomBody,
      response: { 201: S.Room, ...S.errors(400, 401, 403, 409) },
    },
    preHandler: auth,
    handler: async (request, reply) =>
      reply.code(201).send(await services.rooms.create(currentUser(request).id, request.body)),
  });

  app.get('/v1/rooms', {
    schema: {
      tags: ['Salas'],
      summary: 'Listar salas públicas abiertas',
      security: bearer,
      querystring: S.PageQuery,
      response: { 200: S.RoomPage, ...S.errors(400, 401, 403) },
    },
    preHandler: auth,
    handler: (request) => services.rooms.listOpen(request.query),
  });

  app.get('/v1/rooms/:id', {
    schema: {
      tags: ['Salas'],
      summary: 'Ver una sala',
      security: bearer,
      params: S.IdParams,
      response: { 200: S.Room, ...S.errors(400, 401, 403, 404) },
    },
    preHandler: auth,
    handler: (request) => services.rooms.get(request.params.id, currentUser(request).id),
  });

  app.post('/v1/rooms/:id/join', {
    schema: {
      tags: ['Salas'],
      summary: 'Unirse a una sala pública',
      security: bearer,
      params: S.IdParams,
      response: { 200: S.Room, ...S.errors(400, 401, 403, 404, 409) },
    },
    preHandler: auth,
    handler: (request) => services.rooms.join(request.params.id, currentUser(request).id),
  });

  app.post('/v1/rooms/join-by-code', {
    schema: {
      tags: ['Salas'],
      summary: 'Unirse a una sala privada con su código',
      security: bearer,
      body: S.JoinByCodeBody,
      response: { 200: S.Room, ...S.errors(400, 401, 403, 404, 409, 429) },
    },
    config: perUser(limits.authPerMinute),
    preHandler: auth,
    handler: (request) => services.rooms.joinByCode(request.body.inviteCode, currentUser(request).id),
  });

  app.post('/v1/rooms/:id/leave', {
    schema: {
      tags: ['Salas'],
      summary: 'Salir de una sala',
      security: bearer,
      params: S.IdParams,
      response: { 204: z.null(), ...S.errors(400, 401, 403, 404, 409) },
    },
    preHandler: auth,
    handler: async (request, reply) => {
      await services.rooms.leave(request.params.id, currentUser(request).id);
      return reply.code(204).send(null);
    },
  });

  app.put('/v1/rooms/:id/ready', {
    schema: {
      tags: ['Salas'],
      summary: 'Marcar o quitar «listo»',
      description:
        'Cuando hay 2 o más miembros y todos están listos, la sala arranca sola: la respuesta trae status "started" y el matchId.',
      security: bearer,
      params: S.IdParams,
      body: S.ReadyBody,
      response: { 200: S.Room, ...S.errors(400, 401, 403, 404, 409) },
    },
    preHandler: auth,
    handler: (request) => services.rooms.setReady(request.params.id, currentUser(request).id, request.body.ready),
  });

  // --- Emparejamiento ----------------------------------------------------------------------

  app.post('/v1/matchmaking/ticket', {
    schema: {
      tags: ['Emparejamiento'],
      summary: 'Entrar a la cola rápida',
      security: bearer,
      response: { 202: S.TicketStatus, ...S.errors(401, 403, 409) },
    },
    preHandler: auth,
    handler: async (request, reply) =>
      reply.code(202).send(await services.matchmaking.enqueue(currentUser(request).id)),
  });

  app.get('/v1/matchmaking/ticket', {
    schema: {
      tags: ['Emparejamiento'],
      summary: 'Ver el estado de mi ticket',
      security: bearer,
      response: { 200: S.TicketStatus, ...S.errors(401, 403) },
    },
    preHandler: auth,
    handler: (request) => services.matchmaking.status(currentUser(request).id),
  });

  app.delete('/v1/matchmaking/ticket', {
    schema: {
      tags: ['Emparejamiento'],
      summary: 'Salir de la cola',
      security: bearer,
      response: { 204: z.null(), ...S.errors(401, 403) },
    },
    preHandler: auth,
    handler: async (request, reply) => {
      await services.matchmaking.cancel(currentUser(request).id);
      return reply.code(204).send(null);
    },
  });

  // --- Tiempo real --------------------------------------------------------------------------

  app.post('/v1/realtime/tickets', {
    schema: {
      tags: ['Tiempo real'],
      summary: 'Pedir un ticket para abrir el WebSocket',
      description: `Ticket aleatorio de un solo uso y vida corta. Se usa una vez en ${REALTIME_PATH}?ticket=… para abrir la conexión; el protocolo está en el contrato AsyncAPI.`,
      security: bearer,
      response: { 201: S.RealtimeTicket, ...S.errors(401, 403, 429) },
    },
    config: perUser(limits.ticketsPerMinute),
    preHandler: auth,
    handler: async (request, reply) => {
      const ticket = await services.tickets.issue(currentUser(request).id);
      return reply.code(201).send({ ticket, expiresIn: services.tickets.ttlSeconds, path: REALTIME_PATH });
    },
  });

  // --- Partidas ----------------------------------------------------------------------------

  app.get('/v1/matches/:id', {
    schema: {
      tags: ['Partidas'],
      summary: 'Estado visible de una partida',
      description:
        'Solo para participantes. Se usa al conectarse; los cambios llegan por WebSocket, no consultando esta ruta.',
      security: bearer,
      params: S.IdParams,
      response: { 200: S.MatchSnapshot, ...S.errors(400, 401, 403, 404) },
    },
    preHandler: auth,
    handler: async (request) => {
      const snapshot = await services.matches.snapshot(request.params.id, currentUser(request).id);
      return { ...snapshot, view: PlayerViewSchema.parse(snapshot.view) };
    },
  });

  app.get('/v1/matches/:id/replay', {
    schema: {
      tags: ['Historial'],
      summary: 'Repetición jugada por jugada',
      description: 'Solo para participantes y partidas terminadas. Cada evento viene filtrado para quien lo pide.',
      security: bearer,
      params: S.IdParams,
      response: { 200: S.MatchReplay, ...S.errors(400, 401, 403, 404, 409) },
    },
    preHandler: auth,
    handler: async (request) => {
      const replay = await services.matches.replay(request.params.id, currentUser(request).id);
      return {
        matchId: replay.matchId,
        events: replay.events.map((e) => ({ seq: e.seq, event: PlayerEventSchema.parse(e.event) })),
      };
    },
  });
}
