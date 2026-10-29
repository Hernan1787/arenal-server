import { buildApp, loggerOptions, type Lifecycle } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { checkPostgres, createPostgresPool } from './infra/postgres.js';
import { checkRedis, createRedisClient } from './infra/redis.js';
import { createServices } from './services.js';

const VERSION = process.env['APP_VERSION'] ?? '0.1.0-dev';
const MATCHMAKER_INTERVAL_MS = 1_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle: Lifecycle = { draining: false };
  const pool = createPostgresPool(config);
  const redis = createRedisClient(config);

  if (config.RUN_MIGRATIONS) await migrate(pool);
  const services = await createServices(pool, config, systemClock);

  const app = await buildApp({
    version: VERSION,
    lifecycle,
    logger: loggerOptions(config.LOG_LEVEL),
    api: services,
    checks: {
      postgres: () => checkPostgres(pool),
      redis: () => checkRedis(redis),
    },
  });
  if (services.ephemeralJwtKey) {
    app.log.warn('JWT_PRIVATE_KEY no está configurada: se usa una llave temporal (los tokens se invalidan al reiniciar)');
  }

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

  // Barrido de la cola: arma partidas con los que esperan y vence tickets viejos. Cada réplica
  // lo corre; un candado de Postgres hace que solo una a la vez arme partidas.
  let sweeping = false;
  const matchmaker = setInterval(() => {
    if (sweeping || shuttingDown) return;
    sweeping = true;
    services.matchmaking
      .runMatchmaker()
      .catch((err: unknown) => {
        app.log.error({ err }, 'falló el barrido de emparejamiento');
      })
      .finally(() => {
        sweeping = false;
      });
  }, MATCHMAKER_INTERVAL_MS);
  matchmaker.unref();

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.draining = true;
    clearInterval(matchmaker);
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
