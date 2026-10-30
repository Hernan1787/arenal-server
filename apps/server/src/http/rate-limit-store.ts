import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { RedisClient } from '../infra/redis.js';

const PREFIX = 'arenal:ratelimit:';

/**
 * Contadores de límite de tasa en Redis, compartidos por todas las réplicas: el límite es
 * por usuario (o por IP), no por réplica. Ventana fija: el primer golpe crea la clave con su
 * vencimiento y los siguientes solo suman, todo en un MULTI atómico.
 *
 * Si Redis no responde, el plugin deja pasar la solicitud (`skipOnError`): se prefiere la
 * disponibilidad a bloquear a todos los jugadores por una caída del contador.
 */
export function createRedisRateLimitStore(redis: RedisClient): FastifyRateLimitStoreCtor {
  class RedisRateLimitStore implements FastifyRateLimitStore {
    // El plugin construye la tienda con sus opciones; el prefijo de cada ruta lo pone `child`.
    private prefix = PREFIX;

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      const k = this.prefix + key;
      redis
        .multi()
        .incr(k)
        .pExpire(k, timeWindow, 'NX')
        .pTTL(k)
        .exec()
        .then(
          ([current, , ttl]) => {
            callback(null, { current: Number(current), ttl: Math.max(0, Number(ttl)) });
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)));
          },
        );
    }

    /** Un contador por ruta: el plugin pasa la configuración de la ruta con su método y URL. */
    child(options: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      const { routeInfo } = options as unknown as { routeInfo?: { method?: string | string[]; url?: string } };
      const method = Array.isArray(routeInfo?.method) ? routeInfo.method.join(',') : (routeInfo?.method ?? '');
      const store = new RedisRateLimitStore();
      store.prefix = `${PREFIX}${method}${routeInfo?.url ?? ''}:`;
      return store;
    }
  }
  return RedisRateLimitStore;
}
