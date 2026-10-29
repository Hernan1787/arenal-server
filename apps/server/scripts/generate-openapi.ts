import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { createRedisClient } from '../src/infra/redis.js';
import { createServices, silentLog } from '../src/services.js';

/**
 * Genera el contrato OpenAPI 3.1 a partir de las rutas reales. El pool nunca se conecta:
 * construir las rutas no toca la base de datos.
 */
const serverDir = join(import.meta.dirname, '..');
const outFile = join(serverDir, '..', '..', 'packages', 'contracts', 'generated', 'openapi.json');
const { version } = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')) as { version: string };

const pool = new pg.Pool({ max: 1 });
const config = loadConfig({ NODE_ENV: 'test' });
// Ni el pool ni Redis llegan a conectarse: construir las rutas no los usa.
const services = await createServices({
  db: pool,
  redis: createRedisClient(config),
  config,
  clock: systemClock,
  log: silentLog,
});
const app = await buildApp({ version, checks: {}, lifecycle: { draining: false }, api: services });
await app.ready();
writeFileSync(outFile, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await pool.end();
process.stdout.write(`openapi.json generado (versión ${version})\n`);
