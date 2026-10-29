import { z } from 'zod';

/**
 * Configuración por variables de entorno. A propósito no existe ninguna variable de
 * contraseña ni cadena de conexión: en Azure, Postgres y Redis se autentican con la
 * identidad administrada; en local, docker compose corre sin credenciales.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PG_DATABASE: z.string().min(1).default('arenal'),
  PG_USER: z.string().min(1).default('arenal'),
  PG_SSL: z.stringbool().default(false),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_TLS: z.stringbool().default(false),

  /** Tiempo máximo para drenar conexiones al recibir SIGTERM. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(25_000),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Lee y valida el entorno. Si algo está mal, dice qué variable falla sin mostrar su valor. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new ConfigError(`Configuración inválida:\n- ${problems.join('\n- ')}`);
}
