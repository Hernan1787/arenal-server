import type { ProblemSlug } from './http/problem.js';

/**
 * Error esperado de la aplicación (credenciales inválidas, sala llena, sin permiso…).
 * El manejador de errores lo convierte en Problem Details con su código HTTP.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly slug: ProblemSlug,
    message: string,
    /** Código estable para que el cliente distinga casos con el mismo estado HTTP. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string): AppError => new AppError('not-found', `${what} no existe`);
export const forbidden = (message: string): AppError => new AppError('forbidden', message);
export const conflict = (code: string, message: string): AppError => new AppError('conflict', message, code);
export const unauthorized = (message = 'Credenciales inválidas'): AppError => new AppError('unauthorized', message);
