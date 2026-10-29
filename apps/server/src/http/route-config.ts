import type { FastifyRequest } from 'fastify';

/** Seguridad de OpenAPI para las rutas con access token. */
export const bearer = [{ bearerAuth: [] }];

/** Límite por IP, para rutas sin sesión (registro, login). */
export const perIp = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

/**
 * En rutas autenticadas el límite va por usuario y se evalúa después de la guardia: muchos
 * jugadores detrás de la misma IP (una red universitaria, la prueba de carga) no se bloquean entre sí.
 */
export const perUser = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => request.authUser?.id ?? request.ip,
  },
});
