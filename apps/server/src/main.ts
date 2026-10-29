import { buildApp, loggerOptions, type Lifecycle } from './app.js';
import { loadConfig } from './config.js';
import { checkPostgres, createPostgresPool } from './infra/postgres.js';
import { checkRedis, createRedisClient } from './infra/redis.js';

const VERSION = process.env['APP_VERSION'] ?? '0.1.0-dev';

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle: Lifecycle = { draining: false };
  const pool = createPostgresPool(config);
  const redis = createRedisClient(config);

  const app = await buildApp({
    version: VERSION,
    lifecycle,
    logger: loggerOptions(config.LOG_LEVEL),
    checks: {
      postgres: () => checkPostgres(pool),
      redis: () => checkRedis(redis),
    },
  });

  // Sin estos listeners, un error de conexión tumbaría el proceso; así solo se registra
  // y /health/ready responde 503 mientras la dependencia no vuelve.
  pool.on('error', (err) => {
    app.log.error({ err }, 'error en el pool de Postgres');
  });
  redis.on('error', (err: unknown) => {
    app.log.warn({ err }, 'error de conexión con Redis');
  });
  let shuttingDown = false;
  redis.connect().catch((err: unknown) => {
    if (!shuttingDown) app.log.warn({ err }, 'Redis no disponible al arrancar; se seguirá reintentando');
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.draining = true;
    app.log.info({ signal }, 'apagando: drenando conexiones');

    const hardStop = setTimeout(() => {
      app.log.error('el apagado tardó demasiado; se fuerza la salida');
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS);
    hardStop.unref();

    void (async () => {
      await app.close();
      // Si Redis está conectado, se cierra en orden; si sigue reintentando, se corta de una vez.
      const closeRedis = async (): Promise<void> => {
        if (redis.isReady) await redis.close();
        else redis.destroy();
      };
      await Promise.allSettled([pool.end(), closeRedis()]);
      app.log.info('apagado limpio');
      // Sin process.exit: el proceso termina solo al quedar sin conexiones, y los logs alcanzan a salir.
      process.exitCode = 0;
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  process.stderr.write(`No se pudo arrancar el servidor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
