import { buildApp, createLogger, type Lifecycle } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { checkPostgres, createPostgresPool, ensureDatabase } from './infra/postgres.js';
import { checkRedis, createRedisClient } from './infra/redis.js';
import { createRealtime, createServices } from './services.js';

const VERSION = process.env['APP_VERSION'] ?? '0.1.0-dev';

/** Corre `task` cada `ms`, sin solapar ejecuciones y sin que un error detenga el ciclo. */
function every(ms: number, task: () => Promise<unknown>, onError: (err: unknown) => void): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle: Lifecycle = { draining: false };
  const pool = createPostgresPool(config);
  const redis = createRedisClient(config);
  // Conexión aparte para pub/sub, con su propio proveedor de credenciales.
  const subscriber = createRedisClient(config);

  if (config.RUN_MIGRATIONS) {
    await ensureDatabase(config);
    await migrate(pool);
  }

  const log = createLogger(config.LOG_LEVEL);
  const services = await createServices({ db: pool, redis, config, clock: systemClock, log });
  const server = await buildApp({
    version: VERSION,
    lifecycle,
    logger: log,
    allowedOrigins: config.ALLOWED_ORIGINS,
    rateLimits: {
      authPerMinute: config.RATE_LIMIT_AUTH_PER_MINUTE,
      ticketsPerMinute: config.RATE_LIMIT_TICKETS_PER_MINUTE,
      adminPerMinute: config.RATE_LIMIT_ADMIN_PER_MINUTE,
    },
    api: services,
    checks: {
      postgres: () => checkPostgres(pool),
      redis: () => checkRedis(redis),
    },
  });
  if (services.ephemeralJwtKey) {
    server.log.warn(
      'JWT_PRIVATE_KEY no está configurada: se usa una llave temporal (los tokens se invalidan al reiniciar)',
    );
  }

  // Sin estos listeners, un error de conexión tumbaría el proceso; así solo se registra
  // y /health/ready responde 503 mientras la dependencia no vuelve.
  pool.on('error', (err) => {
    server.log.error({ err }, 'error en el pool de Postgres');
  });
  for (const client of [redis, subscriber]) {
    client.on('error', (err: unknown) => {
      server.log.warn({ err }, 'error de conexión con Redis');
    });
  }
  let shuttingDown = false;
  await Promise.all([redis.connect(), subscriber.connect()]);

  const realtime = createRealtime({
    services,
    subscriber,
    config,
    log: server.log,
    isDraining: () => lifecycle.draining,
  });
  realtime.attach(server.server);

  // Cada réplica corre la cola y el reloj del servidor; candados de Postgres y el propio
  // dominio evitan que una misma acción se aplique dos veces.
  const logError = (what: string) => (err: unknown) => {
    server.log.error({ err }, what);
  };
  const stopMatchmaker = every(
    config.SWEEP_INTERVAL_MS,
    () => services.matchmaking.runMatchmaker(),
    logError('falló el barrido de emparejamiento'),
  );
  const stopSweeper = every(
    config.SWEEP_INTERVAL_MS,
    () => services.sweeper.tick(),
    logError('falló el reloj del servidor'),
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.draining = true;
    stopMatchmaker();
    stopSweeper();
    server.log.info({ signal }, 'apagando: drenando conexiones');

    const hardStop = setTimeout(() => {
      server.log.error('el apagado tardó demasiado; se fuerza la salida');
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS);
    hardStop.unref();

    void (async () => {
      // Los jugadores reciben 1012 y reconectan a otra réplica; la partida sigue en Postgres.
      await realtime.close();
      await server.close();
      const closeRedis = async (client: typeof redis): Promise<void> => {
        if (client.isReady) await client.close();
        else client.destroy();
      };
      await Promise.allSettled([pool.end(), closeRedis(redis), closeRedis(subscriber)]);
      server.log.info('apagado limpio');
      // Sin process.exit: el proceso termina solo al quedar sin conexiones, y los logs alcanzan a salir.
      process.exitCode = 0;
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  process.stderr.write(`No se pudo arrancar el servidor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
