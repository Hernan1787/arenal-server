import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ensureDatabase } from '../../src/infra/postgres.js';

const name = `arenal_crear_${randomUUID().slice(0, 8)}`;
const config = loadConfig({
  NODE_ENV: 'test',
  PG_HOST: process.env['PG_HOST'] ?? '127.0.0.1',
  PG_DATABASE: name,
});

afterAll(async () => {
  const admin = new pg.Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe('crear la base al arrancar', () => {
  it('la crea si no existe y no hace nada si ya existe, aunque dos réplicas lo intenten a la vez', async () => {
    const results = await Promise.all([ensureDatabase(config), ensureDatabase(config)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ensureDatabase(config)).toBe(false);
  });
});
