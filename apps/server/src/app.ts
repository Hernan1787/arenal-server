import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { REDACT_PATHS, serializeRequest } from './http/logging.js';
import { buildProblem, sendProblem } from './http/problem.js';

/** Una dependencia que `/health/ready` revisa (Postgres, Redis). Debe fallar lanzando un error. */
export type HealthCheck = () => Promise<void>;

export interface Lifecycle {
  /** `true` desde que llegó SIGTERM: la réplica deja de recibir tráfico nuevo. */
  draining: boolean;
}

export interface AppOptions {
  readonly version: string;
  readonly checks: Readonly<Record<string, HealthCheck>>;
  readonly lifecycle: Lifecycle;
  readonly logger?: FastifyServerOptions['logger'];
  readonly checkTimeoutMs?: number;
}

const BODY_LIMIT_BYTES = 16 * 1024;

function withTimeout(check: HealthCheck, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Sin respuesta en ${ms} ms`));
    }, ms);
    check().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Detrás del ingress de Container Apps: solo se confía en el proxy inmediato.
    trustProxy: (_address, hop) => hop === 0,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  app.get('/health/live', () => ({ status: 'ok', version: options.version }));

  app.get('/health/ready', async (request, reply) => {
    if (options.lifecycle.draining) {
      return sendProblem(reply, buildProblem('not-ready', { detail: 'La réplica se está apagando' }));
    }
    const timeoutMs = options.checkTimeoutMs ?? 1500;
    const entries = Object.entries(options.checks);
    const outcomes = await Promise.allSettled(entries.map(([, check]) => withTimeout(check, timeoutMs)));
    const checks: Record<string, 'ok' | 'fail'> = {};
    entries.forEach(([name], i) => {
      const outcome = outcomes[i];
      checks[name] = outcome?.status === 'fulfilled' ? 'ok' : 'fail';
      if (outcome?.status === 'rejected') {
        request.log.warn({ check: name, err: outcome.reason as unknown }, 'dependencia no disponible');
      }
    });
    if (Object.values(checks).includes('fail')) {
      return sendProblem(reply, buildProblem('not-ready', { extensions: { checks } }));
    }
    return { status: 'ready', checks };
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, buildProblem('not-found', { instance: serializeRequest(request)['path'] ?? '' })),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const instance = serializeRequest(request)['path'] ?? '';
    if (error.validation !== undefined) {
      return sendProblem(reply, buildProblem('validation-error', { detail: error.message, instance }));
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendProblem(reply, buildProblem('payload-too-large', { instance }));
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return sendProblem(reply, {
        ...buildProblem('validation-error', { detail: error.message, instance }),
        status,
        title: 'La solicitud no se pudo procesar',
      });
    }
    request.log.error({ err: error }, 'error no controlado');
    return sendProblem(reply, buildProblem('internal', { instance }));
  });

  return app;
}

export const loggerOptions = (level: string): FastifyServerOptions['logger'] => ({
  level,
  redact: { paths: REDACT_PATHS, censor: '[oculto]' },
  serializers: { req: serializeRequest },
});
