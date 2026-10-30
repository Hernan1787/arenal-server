/**
 * Arranque de OpenTelemetry hacia Application Insights. Lo carga `src/instrument.ts` con
 * `node --import` antes que el resto del servidor, para que las instrumentaciones de HTTP,
 * Postgres y Redis alcancen a envolver esos módulos al cargarse. Los logs de pino no pasan por
 * aquí: salen por stdout a Log Analytics con el trace_id de la traza activa.
 *
 * Sin `APPLICATIONINSIGHTS_CONNECTION_STRING` no hace nada: en local y en las pruebas la API
 * de OpenTelemetry queda en modo no-op.
 */
import type { IncomingMessage } from 'node:http';

// Las librerías de telemetría se cargan solo si hay a dónde mandar: en local ni se importan.
let shutdown: (() => Promise<void>) | undefined;

/** Las sondas de salud no se trazan: son muchas y no dicen nada. */
export const ignoreIncomingRequest = (request: Pick<IncomingMessage, 'url'>): boolean =>
  request.url?.startsWith('/health/') === true;

/**
 * Redis: solo el nombre del comando, nunca sus argumentos (podrían traer IDs de usuario o
 * hashes de tickets).
 */
export const redisStatement = (command: string): string => command;

export async function startTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const connectionString = env['APPLICATIONINSIGHTS_CONNECTION_STRING'];
  if (shutdown !== undefined || connectionString === undefined || connectionString === '') return false;

  const [{ ManagedIdentityCredential }, monitor, resources] = await Promise.all([
    import('@azure/identity'),
    import('@azure/monitor-opentelemetry'),
    import('@opentelemetry/resources'),
  ]);

  const clientId = env['AZURE_CLIENT_ID'];
  const http = { enabled: true, ignoreIncomingRequestHook: ignoreIncomingRequest };
  const redis = { enabled: true, dbStatementSerializer: redisStatement };
  monitor.useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      // La ingesta local está desactivada: la telemetría entra con la identidad administrada.
      credential: new ManagedIdentityCredential(clientId === undefined ? {} : { clientId }),
    },
    resource: resources.resourceFromAttributes({
      'service.name': 'arenal-server',
      'service.version': env['APP_VERSION'] ?? 'dev',
      'service.instance.id': env['REPLICA_ID'] ?? env['HOSTNAME'] ?? 'local',
    }),
    samplingRatio: 1,
    tracesPerSecond: 0,
    enableLiveMetrics: true,
    instrumentationOptions: {
      http,
      postgreSql: { enabled: true },
      redis,
      azureSdk: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      bunyan: { enabled: false },
      winston: { enabled: false },
    },
  });
  shutdown = monitor.shutdownAzureMonitor;
  return true;
}

/** Manda lo que quede pendiente antes de que el proceso termine. */
export async function flushTelemetry(): Promise<void> {
  const pending = shutdown;
  shutdown = undefined;
  await pending?.();
}
