import { DEFAULT_TOKEN_MANAGER_CONFIG, EntraIdCredentialsProviderFactory, REDIS_SCOPE_DEFAULT } from '@redis/entraid';
import { createClient } from 'redis';
import type { Config } from '../config.js';
import { azureCredential } from './azure-identity.js';

export type RedisClient = ReturnType<typeof createClient>;

/**
 * Cliente de Redis. En local, sin credenciales. En Azure Managed Redis (`REDIS_AUTH=entra`)
 * se autentica con la identidad administrada: el usuario es su object ID y la contraseña un
 * token de Entra ID que la librería renueva sola, también en las conexiones de pub/sub.
 *
 * Cada llamada crea su propio proveedor de credenciales; el suscriptor se crea con otra
 * llamada (no con `duplicate()`), así cada conexión renueva su token por separado.
 */
export function createRedisClient(config: Config): RedisClient {
  const socket = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    connectTimeout: 5_000,
    reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 5_000),
  };
  return createClient({
    // RESP3: en RESP2 una conexión suscrita a pub/sub no puede renovar su token sin reconectar.
    RESP: 3,
    socket: config.REDIS_TLS ? { ...socket, tls: true } : { ...socket, tls: false },
    database: config.REDIS_DB,
    ...(config.REDIS_AUTH === 'entra' && {
      credentialsProvider: EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
        credential: azureCredential(config),
        scopes: REDIS_SCOPE_DEFAULT,
        tokenManagerConfig: DEFAULT_TOKEN_MANAGER_CONFIG,
      }),
    }),
  });
}

export async function checkRedis(client: RedisClient): Promise<void> {
  if (!client.isReady) throw new Error('Redis no está conectado');
  await client.ping();
}
