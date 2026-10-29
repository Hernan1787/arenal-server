import { createClient } from 'redis';
import type { Config } from '../config.js';

export type RedisClient = ReturnType<typeof createClient>;

/**
 * Cliente de Redis. En local sin credenciales; en Azure Managed Redis el siguiente paso
 * es autenticar con `@redis/entraid` y la identidad administrada.
 */
export function createRedisClient(config: Config): RedisClient {
  const socket = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    connectTimeout: 2_000,
    reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 5_000),
  };
  return createClient({ socket: config.REDIS_TLS ? { ...socket, tls: true } : { ...socket, tls: false } });
}

export async function checkRedis(client: RedisClient): Promise<void> {
  if (!client.isReady) throw new Error('Redis no está conectado');
  await client.ping();
}
