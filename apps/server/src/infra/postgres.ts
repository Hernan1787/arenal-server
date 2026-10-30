import type { TokenCredential } from '@azure/identity';
import pg from 'pg';
import type { Config } from '../config.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from '../db/tx.js';
import { azureCredential } from './azure-identity.js';

/** Audiencia de los tokens de Entra ID para Azure Database for PostgreSQL. */
const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
/** Se pide un token nuevo cuando al actual le quedan menos de 5 minutos. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Contraseña como función: cada conexión nueva del pool usa un token de Entra ID vigente de
 * la identidad administrada. No hay contraseña guardada en ningún lado.
 */
export function entraPassword(credential: TokenCredential, now: () => number = Date.now): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached === undefined || cached.expiresAt - now() < REFRESH_MARGIN_MS) {
      const token = await credential.getToken(POSTGRES_SCOPE);
      if (token === null) throw new Error('La identidad administrada no entregó un token para Postgres');
      cached = { token: token.token, expiresAt: token.expiresOnTimestamp };
    }
    return cached.token;
  };
}

/** Opciones de conexión comunes al pool y a las conexiones sueltas. */
function connectionOptions(config: Config): pg.ClientConfig {
  return {
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USER,
    ...(config.PG_AUTH === 'entra' && { password: entraPassword(azureCredential(config)) }),
    ssl: config.PG_SSL ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5_000,
    application_name: 'arenal-server',
  };
}

/**
 * Pool de Postgres. En local se conecta sin contraseña (docker compose usa `trust`). En Azure
 * (`PG_AUTH=entra`) el usuario es el nombre de la identidad administrada y la contraseña es
 * un token de Entra ID.
 */
export function createPostgresPool(config: Config): pg.Pool {
  return new pg.Pool({ ...connectionOptions(config), max: 10, idleTimeoutMillis: 30_000 });
}

const INVALID_CATALOG_NAME = '3D000';
const DUPLICATE_DATABASE = '42P04';

/**
 * Crea la base si no existe, conectándose a `postgres`. En Azure la base la crea la propia
 * identidad de la app y no la plantilla: así es su dueña y puede crear tablas en `public`
 * sin permisos extra. Si dos réplicas arrancan juntas, la segunda ve la base ya creada.
 */
export async function ensureDatabase(config: Config): Promise<boolean> {
  const probe = new pg.Client(connectionOptions(config));
  try {
    await probe.connect();
    return false;
  } catch (error) {
    if (pgErrorCode(error) !== INVALID_CATALOG_NAME) throw error;
  } finally {
    await probe.end().catch(() => undefined);
  }

  const admin = new pg.Client({ ...connectionOptions(config), database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(config.PG_DATABASE)}`);
    return true;
  } catch (error) {
    // Si otra réplica la creó en el mismo instante, Postgres responde 42P04 o, en plena
    // carrera, una violación de unicidad del catálogo (23505).
    const code = pgErrorCode(error);
    if (code === DUPLICATE_DATABASE || code === PG_UNIQUE_VIOLATION) return false;
    throw error;
  } finally {
    await admin.end();
  }
}

export async function checkPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
