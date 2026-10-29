import type { FastifyReply } from 'fastify';

/** Errores HTTP en formato Problem Details (RFC 9457). Cada `type` está descrito en docs/problems.md. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const PROBLEMS = {
  'validation-error': { status: 400, title: 'La solicitud no es válida' },
  unauthorized: { status: 401, title: 'Falta autenticación o no es válida' },
  forbidden: { status: 403, title: 'No tienes permiso para esto' },
  'not-found': { status: 404, title: 'No existe' },
  conflict: { status: 409, title: 'Conflicto con el estado actual' },
  'payload-too-large': { status: 413, title: 'La solicitud es demasiado grande' },
  'rate-limited': { status: 429, title: 'Demasiadas solicitudes' },
  'not-ready': { status: 503, title: 'El servicio no está listo' },
  internal: { status: 500, title: 'Error interno' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemSlug = keyof typeof PROBLEMS;

export function buildProblem(
  slug: ProblemSlug,
  options: { detail?: string; instance?: string; extensions?: Record<string, unknown> } = {},
): ProblemDetails {
  const { status, title } = PROBLEMS[slug];
  return {
    type: `/problems/${slug}`,
    title,
    status,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    ...options.extensions,
  };
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}
