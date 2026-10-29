import pg from 'pg';
import type { Config } from '../config.js';

/**
 * Pool de Postgres. En local se conecta sin contraseña (docker compose usa `trust`).
 * En Azure el siguiente paso es pasar `password` como función que pide un token de
 * Entra ID con la identidad administrada; no hay contraseña guardada en ningún lado.
 */
export function createPostgresPool(config: Config): pg.Pool {
  return new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USER,
    ssl: config.PG_SSL ? { rejectUnauthorized: true } : false,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: 'arenal-server',
  });
}

export async function checkPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
