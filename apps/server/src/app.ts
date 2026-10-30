import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { pino } from 'pino';
import { traceFields } from './observability/tracing.js';
import { AppError } from './errors.js';
import { REDACT_PATHS, serializeRequest } from './http/logging.js';
import { buildProblem, sendProblem } from './http/problem.js';
import { registerApiRoutes, type ApiServices, type RateLimits } from './http/routes.js';

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
  /** Logger de pino ya configurado; sin él, la app no escribe logs. */
  readonly logger?: FastifyBaseLogger;
  readonly checkTimeoutMs?: number;
  /** Servicios de la API v1. Sin ellos la app solo expone las sondas de salud. */
  readonly api?: ApiServices;
  /** Orígenes de navegador permitidos (CORS). Sin lista, ningún origen cruzado. */
  readonly allowedOrigins?: readonly string[];
  readonly rateLimits?: RateLimits;
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

const API_DESCRIPTION = [
  'API REST del servidor de Arenal: usuarios, salas, emparejamiento, partidas e historial.',
  '',
  'Todo lo que pasa durante una partida (jugadas, eventos, reconexión) va por WebSocket y está',
  'documentado en el contrato AsyncAPI (`packages/contracts/generated/asyncapi.yaml`).',
  '',
  'Los errores siguen RFC 9457 (`application/problem+json`); el catálogo está en `docs/problems.md`.',
].join('\n');

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger === undefined ? { logger: false } : { loggerInstance: options.logger }),
    bodyLimit: BODY_LIMIT_BYTES,
    // Detrás del ingress de Container Apps: solo se confía en el proxy inmediato.
    trustProxy: (_address, hop) => hop === 0,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('authUser', null);

  // Muchos clientes mandan `content-type: application/json` también en un POST sin cuerpo
  // (pedir un ticket, entrar a la cola). Un cuerpo vacío cuenta como «sin cuerpo»; el resto
  // pasa por el parser de Fastify, que bloquea __proto__ y constructor.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '') {
      done(null, undefined);
      return;
    }
    void jsonParser(request, text, done);
  });

  await app.register(helmet, {
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: [...(options.allowedOrigins ?? [])],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    // Solo las rutas que lo piden (login, registro…). Por ahora en memoria de cada réplica;
    // el bloque de seguridad lo pasa a Redis para que el límite sea compartido.
    global: false,
    errorResponseBuilder: (_request, context) =>
      new AppError('rate-limited', `Demasiadas solicitudes; vuelve a intentar en ${context.after}`),
  });

  if (options.api !== undefined) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: { title: 'Arenal — API REST', version: options.version, description: API_DESCRIPTION },
        tags: [
          { name: 'Usuarios' },
          { name: 'Salas' },
          { name: 'Emparejamiento' },
          { name: 'Tiempo real' },
          { name: 'Partidas' },
          { name: 'Historial' },
          { name: 'Administración', description: 'Solo para el rol administrador; cada acción queda auditada.' },
        ],
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
    await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  }

  app.get('/health/live', { schema: { hide: true } }, () => ({ status: 'ok', version: options.version }));

  app.get('/health/ready', { schema: { hide: true } }, async (request, reply) => {
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

  if (options.api !== undefined) registerApiRoutes(app, options.api, options.rateLimits);

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, buildProblem('not-found', { instance: serializeRequest(request)['path'] ?? '' })),
  );

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const instance = serializeRequest(request)['path'] ?? '';

    if (error instanceof AppError) {
      if (error.slug === 'unauthorized') void reply.header('www-authenticate', 'Bearer');
      return sendProblem(
        reply,
        buildProblem(error.slug, {
          detail: error.message,
          instance,
          ...(error.code === undefined ? {} : { extensions: { code: error.code } }),
        }),
      );
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      // Se describen los campos y las reglas, nunca los valores que mandó el cliente.
      const detail = error.validation
        .map(
          (issue) =>
            `${issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || error.validationContext || 'solicitud'}: ${issue.message ?? 'inválido'}`,
        )
        .join('; ');
      return sendProblem(reply, buildProblem('validation-error', { detail, instance }));
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'la respuesta no cumple su esquema');
      return sendProblem(reply, buildProblem('internal', { instance }));
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

/** Logger del servidor: JSON, sin datos sensibles y con la URL sin query string. */
export const createLogger = (level: string): FastifyBaseLogger =>
  pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[oculto]' },
    serializers: { req: serializeRequest, err: pino.stdSerializers.err },
    // Cada línea lleva la traza activa: en Log Analytics se cruza con Application Insights
    // (trace_id = operation_Id) y se llega a la solicitud o la jugada que la produjo.
    mixin: traceFields,
  });
