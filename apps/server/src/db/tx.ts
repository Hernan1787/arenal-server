import type pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Corre `work` en una transacción: COMMIT si termina bien, ROLLBACK si lanza. */
export async function withTransaction<T>(pool: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Código de error de Postgres, si el error viene de Postgres. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
