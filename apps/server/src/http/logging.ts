import type { FastifyRequest } from 'fastify';

/**
 * Cómo se escribe una solicitud en los logs. La URL va sin query string porque el ticket
 * del WebSocket viaja ahí, y nunca se registran encabezados (Authorization, cookies).
 */
export function serializeRequest(request: Pick<FastifyRequest, 'id' | 'method' | 'url'>): Record<string, string> {
  const queryStart = request.url.indexOf('?');
  return {
    id: request.id,
    method: request.method,
    path: queryStart === -1 ? request.url : request.url.slice(0, queryStart),
  };
}

/** Rutas que pino reemplaza por «[oculto]» si llegan a aparecer en un log. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
  '*.ticket',
];
