import { hostname } from 'node:os';
import { z } from 'zod';

const ms = (max: number, fallback: number) => z.coerce.number().int().min(0).max(max).default(fallback);

/**
 * Configuración por variables de entorno. No existe ninguna variable de contraseña de base
 * de datos ni de Redis: en Azure se autentican con la identidad administrada; en local,
 * docker compose corre sin credenciales. El único secreto, la llave de firma de los JWT,
 * llega desde Key Vault como variable de entorno (referencia de secreto de Container Apps).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.url().optional(),
  /** Nombre de esta réplica en la vista de conexiones. En Container Apps, el hostname es el nombre de la réplica. */
  REPLICA_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/)
    .default(() => hostname()),

  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PG_DATABASE: z.string().min(1).default('arenal'),
  PG_USER: z.string().min(1).default('arenal'),
  PG_SSL: z.stringbool().default(false),
  RUN_MIGRATIONS: z.stringbool().default(true),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_TLS: z.stringbool().default(false),
  /** Base lógica de Redis. Producción usa la 0; las pruebas usan otra para poder vaciarla. */
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),

  /** Llave privada ES256 en PEM (PKCS#8). Obligatoria en producción. */
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_ISSUER: z.string().min(1).default('arenal'),
  JWT_AUDIENCE: z.string().min(1).default('arenal-api'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TOKEN_TTL_S: z.coerce
    .number()
    .int()
    .min(3600)
    .max(30 * 24 * 3600)
    .default(7 * 24 * 3600),

  TURN_TIMEOUT_MS: ms(600_000, 30_000),
  DISCONNECT_GRACE_MS: ms(600_000, 60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),

  /** Orígenes permitidos para el navegador (CORS y WebSocket), separados por coma. */
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8080')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  /** Límites por minuto. Se suben solo para la prueba de carga. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(10),
  RATE_LIMIT_TICKETS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  RATE_LIMIT_ADMIN_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  WS_TICKET_TTL_S: z.coerce.number().int().min(5).max(300).default(30),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  WS_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(200).max(300_000).default(30_000),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(20).default(3),
  WS_MESSAGES_PER_SECOND: z.coerce.number().min(0.1).max(1000).default(10),
  WS_MESSAGE_BURST: z.coerce.number().int().min(1).max(1000).default(20),

  MATCHMAKING_MATCH_SIZE: z.coerce.number().int().min(2).max(5).default(4),
  /** Después de esta espera, la cola arma partida con los que haya (mínimo 2). */
  MATCHMAKING_FILL_AFTER_MS: ms(600_000, 10_000),
  /** Tiempo máximo de espera: si no se arma partida antes, el ticket vence. */
  MATCHMAKING_MAX_WAIT_MS: ms(3_600_000, 60_000),

  /** Tiempo máximo para drenar conexiones al recibir SIGTERM. */
  SHUTDOWN_GRACE_MS: ms(600_000, 25_000),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Lee y valida el entorno. Si algo está mal, dice qué variable falla sin mostrar su valor. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Configuración inválida:\n- ${problems.join('\n- ')}`);
  }
  const config = result.data;
  if (config.NODE_ENV === 'production' && config.JWT_PRIVATE_KEY === undefined) {
    throw new ConfigError('Configuración inválida:\n- JWT_PRIVATE_KEY: obligatoria en producción (viene de Key Vault)');
  }
  if (config.MATCHMAKING_FILL_AFTER_MS > config.MATCHMAKING_MAX_WAIT_MS) {
    throw new ConfigError(
      'Configuración inválida:\n- MATCHMAKING_FILL_AFTER_MS no puede pasar de MATCHMAKING_MAX_WAIT_MS',
    );
  }
  return config;
}
