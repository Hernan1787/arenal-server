import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { AdminService } from './admin/admin-service.js';
import { AuthService } from './auth/auth-service.js';
import { createTokenIssuer } from './auth/tokens.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { ApiServices } from './http/routes.js';
import type { RedisClient } from './infra/redis.js';
import { MatchmakingService } from './lobby/matchmaking-service.js';
import { RoomsService } from './lobby/rooms-service.js';
import { MatchStore } from './matches/match-store.js';
import { MatchesService } from './matches/matches-service.js';
import { createGameMetrics, type GameMetrics } from './observability/metrics.js';
import { RedisEventBus, type EventBus } from './realtime/bus.js';
import { RealtimeGateway } from './realtime/gateway.js';
import { Presence } from './realtime/presence.js';
import { Sweeper } from './realtime/sweeper.js';
import { TicketStore } from './realtime/tickets.js';
import { cryptoRng } from './rng.js';

export interface Services extends ApiServices {
  readonly store: MatchStore;
  readonly bus: EventBus;
  readonly presence: Presence;
  readonly sweeper: Sweeper;
  readonly metrics: GameMetrics;
  readonly ephemeralJwtKey: boolean;
}

/** Logger que no escribe nada (para construir servicios fuera del servidor, como al generar OpenAPI). */
export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Arma los servicios de la aplicación con sus dependencias reales. */
export async function createServices(deps: {
  db: pg.Pool;
  redis: RedisClient;
  config: Config;
  clock: Clock;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}): Promise<Services> {
  const { db, redis, config, clock, log } = deps;
  const tokens = await createTokenIssuer(config);
  const bus = new RedisEventBus(redis, log);
  // Se crean aquí y no al importar el módulo: así ya está registrado el SDK de OpenTelemetry.
  const metrics = createGameMetrics();
  const store = new MatchStore({ db, clock, rng: cryptoRng, turnTimeoutMs: config.TURN_TIMEOUT_MS, bus, metrics });
  // El arriendo de presencia cubre dos heartbeats: si no llega un pong en ese tiempo, la conexión se da por muerta.
  const presence = new Presence({
    redis,
    db,
    clock,
    leaseMs: config.WS_HEARTBEAT_TIMEOUT_MS + config.WS_HEARTBEAT_INTERVAL_MS,
    replicaId: config.REPLICA_ID,
  });
  const rooms = new RoomsService({ db, store, bus });
  return {
    tokens,
    store,
    bus,
    presence,
    metrics,
    ephemeralJwtKey: tokens.ephemeralKey,
    tickets: new TicketStore(redis, config.WS_TICKET_TTL_S),
    auth: new AuthService({ db, tokens, clock, refreshTtlSeconds: config.REFRESH_TOKEN_TTL_S }),
    rooms,
    admin: new AdminService({ db, store, rooms, presence, bus, clock, log }),
    matches: new MatchesService({ db, store }),
    matchmaking: new MatchmakingService({
      db,
      store,
      clock,
      bus,
      policy: {
        matchSize: config.MATCHMAKING_MATCH_SIZE,
        fillAfterMs: config.MATCHMAKING_FILL_AFTER_MS,
        maxWaitMs: config.MATCHMAKING_MAX_WAIT_MS,
      },
    }),
    sweeper: new Sweeper({ db, store, presence, clock, graceMs: config.DISCONNECT_GRACE_MS, log }),
  };
}

/** Arma el gateway de WebSocket. `subscriber` es una conexión de Redis solo para suscripciones. */
export function createRealtime(deps: {
  services: Services;
  subscriber: RedisClient;
  config: Config;
  log: FastifyBaseLogger;
  isDraining: () => boolean;
}): RealtimeGateway {
  const { services, config } = deps;
  return new RealtimeGateway({
    store: services.store,
    matches: services.matches,
    auth: services.auth,
    tickets: services.tickets,
    presence: services.presence,
    subscriber: deps.subscriber,
    log: deps.log,
    isDraining: deps.isDraining,
    metrics: services.metrics,
    options: {
      allowedOrigins: config.ALLOWED_ORIGINS,
      heartbeatIntervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: config.WS_HEARTBEAT_TIMEOUT_MS,
      maxConnectionsPerUser: config.WS_MAX_CONNECTIONS_PER_USER,
      messagesPerSecond: config.WS_MESSAGES_PER_SECOND,
      messageBurst: config.WS_MESSAGE_BURST,
    },
  });
}
