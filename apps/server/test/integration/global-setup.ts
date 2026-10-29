import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

/**
 * Crea una base limpia para las pruebas de integración y aplica las migraciones.
 * Usa la misma conexión que el servidor (PG_HOST, PG_USER…), que en docker compose y en
 * el CI no lleva contraseña.
 */
export const TEST_DATABASE = process.env['TEST_PG_DATABASE'] ?? 'arenal_test';

const connection = (database: string) => ({
  host: process.env['PG_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PG_PORT'] ?? 5432),
  user: process.env['PG_USER'] ?? 'arenal',
  database,
});

export default async function setup(): Promise<void> {
  const admin = new pg.Client(connection(process.env['PG_DATABASE'] ?? 'arenal'));
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      'Las pruebas de integración necesitan Postgres. Levántalo con `docker compose up -d postgres` y vuelve a correr `pnpm test:integration`.',
      { cause: error },
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();

  const pool = new pg.Pool(connection(TEST_DATABASE));
  await migrate(pool);
  await pool.end();
}
