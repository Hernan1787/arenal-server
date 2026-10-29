import type pg from 'pg';
import { MIGRATIONS, type Migration } from './migrations.js';

/** Clave del candado de Postgres que evita que dos réplicas migren a la vez. */
const MIGRATION_LOCK_KEY = 72_601_001;

/**
 * Aplica las migraciones pendientes. Cada una corre en su propia transacción y queda
 * registrada en `schema_migrations`. Si varias réplicas arrancan juntas, el candado de
 * sesión hace que una migre y las demás esperen y no hagan nada.
 */
export async function migrate(pool: pg.Pool, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));

    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${migration.id}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
