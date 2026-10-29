import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Clock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { createServices, type Services } from '../../src/services.js';

/** Reloj que las pruebas mueven a mano (la cola de emparejamiento depende del tiempo). */
export class FakeClock implements Clock {
  private current = new Date('2026-11-01T12:00:00Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: pg.Pool;
  readonly services: Services;
  readonly clock: FakeClock;
}

const TABLES = ['match_moves', 'match_events', 'match_players', 'room_members', 'rooms', 'matches', 'matchmaking_tickets', 'refresh_tokens', 'users'];

/**
 * Levanta la app completa contra la base de pruebas. Entre pruebas vacía las tablas, así
 * cada una arranca de cero.
 */
export function useHarness(env: Record<string, string> = {}): Harness {
  const harness = {} as { app: FastifyInstance; db: pg.Pool; services: Services; clock: FakeClock };

  beforeAll(async () => {
    harness.db = new pg.Pool({
      host: process.env['PG_HOST'] ?? '127.0.0.1',
      port: Number(process.env['PG_PORT'] ?? 5432),
      user: process.env['PG_USER'] ?? 'arenal',
      database: process.env['TEST_PG_DATABASE'] ?? 'arenal_test',
      max: 30,
    });
    harness.clock = new FakeClock();
    const config = loadConfig({
      NODE_ENV: 'test',
      MATCHMAKING_MATCH_SIZE: '4',
      MATCHMAKING_FILL_AFTER_MS: '10000',
      MATCHMAKING_MAX_WAIT_MS: '60000',
      ...env,
    });
    harness.services = await createServices(harness.db, config, harness.clock);
    harness.app = await buildApp({ version: 'test', checks: {}, lifecycle: { draining: false }, api: harness.services });
    await harness.app.ready();
  });

  afterEach(async () => {
    await harness.db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await harness.app.close();
    await harness.db.end();
  });

  return harness;
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
