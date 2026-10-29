import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Clock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createRedisClient, type RedisClient } from '../../src/infra/redis.js';
import type { RealtimeGateway } from '../../src/realtime/gateway.js';
import { createRealtime, createServices, silentLog, type Services } from '../../src/services.js';

/** Reloj que las pruebas mueven a mano (cola, temporizadores y periodo de gracia dependen del tiempo). */
export class FakeClock implements Clock {
  private current = new Date('2026-11-01T12:00:00Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Una réplica del servidor: su app, sus servicios y, si se pidió, su WebSocket. */
export interface Replica {
  readonly app: FastifyInstance;
  readonly services: Services;
  readonly realtime: RealtimeGateway | null;
  readonly baseUrl: string;
  readonly draining: { value: boolean };
}

export interface Harness extends Replica {
  readonly db: pg.Pool;
  readonly redis: RedisClient;
  readonly clock: FakeClock;
  readonly config: Config;
  /** Levanta otra réplica sobre la misma base y el mismo Redis (para probar varias instancias). */
  addReplica(): Promise<Replica>;
}

const TABLES = [
  'match_moves',
  'match_events',
  'match_players',
  'room_members',
  'rooms',
  'matches',
  'matchmaking_tickets',
  'refresh_tokens',
  'users',
];

export interface HarnessOptions {
  readonly env?: Record<string, string>;
  /** Abre un puerto real y monta el WebSocket. */
  readonly realtime?: boolean;
}

/**
 * Levanta la app completa contra la base de pruebas y Redis (base 15). Entre pruebas vacía
 * las tablas y Redis, así cada una arranca de cero.
 */
export function useHarness(options: HarnessOptions = {}): Harness {
  const h = {} as {
    -readonly [K in keyof Harness]: Harness[K];
  };
  const replicas: { replica: Replica; close: () => Promise<void> }[] = [];
  const clients: RedisClient[] = [];

  const newRedis = async (): Promise<RedisClient> => {
    const client = createRedisClient(h.config);
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    return client;
  };

  const startReplica = async (): Promise<Replica> => {
    const redis = await newRedis();
    // Cada réplica con su nombre, como en Container Apps (sale en la vista de conexiones).
    const config = { ...h.config, REPLICA_ID: `replica-${replicas.length + 1}` };
    const services = await createServices({ db: h.db, redis, config, clock: h.clock, log: silentLog });
    const draining = { value: false };
    const app = await buildApp({
      version: 'test',
      checks: {},
      lifecycle: {
        get draining() {
          return draining.value;
        },
      },
      api: services,
      allowedOrigins: h.config.ALLOWED_ORIGINS,
      rateLimits: {
        authPerMinute: h.config.RATE_LIMIT_AUTH_PER_MINUTE,
        ticketsPerMinute: h.config.RATE_LIMIT_TICKETS_PER_MINUTE,
        adminPerMinute: h.config.RATE_LIMIT_ADMIN_PER_MINUTE,
      },
    });
    let realtime: RealtimeGateway | null = null;
    let baseUrl = '';
    if (options.realtime === true) {
      const subscriber = await newRedis();
      realtime = createRealtime({
        services,
        subscriber,
        config: h.config,
        log: app.log,
        isDraining: () => draining.value,
      });
      realtime.attach(app.server);
      await app.listen({ host: '127.0.0.1', port: 0 });
      baseUrl = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    } else {
      await app.ready();
    }
    const replica: Replica = { app, services, realtime, baseUrl, draining };
    replicas.push({
      replica,
      close: async () => {
        await realtime?.close(1012, 'Fin de la prueba');
        await app.close();
      },
    });
    return replica;
  };

  beforeAll(async () => {
    h.config = loadConfig({
      NODE_ENV: 'test',
      PG_HOST: process.env['PG_HOST'] ?? '127.0.0.1',
      REDIS_HOST: process.env['REDIS_HOST'] ?? '127.0.0.1',
      REDIS_DB: '15',
      MATCHMAKING_MATCH_SIZE: '4',
      MATCHMAKING_FILL_AFTER_MS: '10000',
      MATCHMAKING_MAX_WAIT_MS: '60000',
      ...options.env,
    });
    h.db = new pg.Pool({
      host: h.config.PG_HOST,
      port: h.config.PG_PORT,
      user: h.config.PG_USER,
      database: process.env['TEST_PG_DATABASE'] ?? 'arenal_test',
      max: 30,
    });
    h.clock = new FakeClock();
    h.redis = await newRedis();
    await h.redis.flushDb();
    const main = await startReplica();
    Object.assign(h, main);
    h.addReplica = startReplica;
  });

  afterEach(async () => {
    // Cierra las réplicas extra que haya levantado la prueba.
    while (replicas.length > 1) await replicas.pop()?.close();
    // La auditoría bloquea TRUNCATE (es de solo inserción); solo aquí, en pruebas, se apaga un momento.
    await h.db.query(`BEGIN;
      ALTER TABLE admin_audit DISABLE TRIGGER admin_audit_no_truncate;
      TRUNCATE admin_audit, ${TABLES.join(', ')} RESTART IDENTITY CASCADE;
      ALTER TABLE admin_audit ENABLE TRIGGER admin_audit_no_truncate;
      COMMIT;`);
    await h.redis.flushDb();
  });

  afterAll(async () => {
    for (const r of replicas.reverse()) await r.close();
    for (const c of clients) if (c.isOpen) c.destroy();
    await h.db.end();
  });

  return h;
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly auth: { authorization: string };
}

let counter = 0;

export async function registerUser(app: FastifyInstance, name?: string): Promise<TestUser> {
  counter += 1;
  const email = `jugador${counter}-${randomUUID().slice(0, 6)}@ejemplo.com`;
  // Generada en cada corrida: ninguna contraseña queda escrita en el repo.
  const password = `p-${randomUUID()}`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    // Cada usuario de prueba viene de una IP distinta para no chocar con el límite de tasa.
    remoteAddress: `10.0.${Math.floor(counter / 250)}.${counter % 250}`,
    payload: { email, password, displayName: name ?? `Jugador ${counter}` },
  });
  if (res.statusCode !== 201) throw new Error(`Registro falló: ${res.statusCode} ${res.body}`);
  const body = res.json<{ user: { id: string }; accessToken: string; refreshToken: string }>();
  return {
    id: body.user.id,
    email,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

export async function registerUsers(app: FastifyInstance, count: number): Promise<TestUser[]> {
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) users.push(await registerUser(app));
  return users;
}

export function expectProblem(res: LightMyRequestResponse, status: number, code?: string): Record<string, unknown> {
  if (res.statusCode !== status) throw new Error(`Se esperaba ${status} y llegó ${res.statusCode}: ${res.body}`);
  if (!String(res.headers['content-type']).includes('application/problem+json')) {
    throw new Error(`Se esperaba application/problem+json y llegó ${String(res.headers['content-type'])}`);
  }
  const body = res.json<Record<string, unknown>>();
  if (code !== undefined && body['code'] !== code) throw new Error(`Se esperaba el código ${code}: ${res.body}`);
  return body;
}
