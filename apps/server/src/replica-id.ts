import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Nombre de esta réplica: sale en /health/live, en la vista de conexiones y en la telemetría.
 * En un ambiente Express de Container Apps todas las réplicas tienen el mismo hostname
 * (`adc-sandbox`), así que se usa el nombre que da Container Apps si existe y, si no, el hostname
 * con un sufijo al azar. Se calcula una vez por proceso, para que todos lo vean igual.
 */
export function replicaIdFrom(env: NodeJS.ProcessEnv, suffix = randomBytes(3).toString('hex')): string {
  return env['REPLICA_ID'] ?? env['CONTAINER_APP_REPLICA_NAME'] ?? `${hostname()}-${suffix}`;
}

export const REPLICA_ID = replicaIdFrom(process.env);
