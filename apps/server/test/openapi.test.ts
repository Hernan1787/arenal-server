import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileErrors, validate } from '@readme/openapi-parser';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { createServices } from '../src/services.js';

// Construir las rutas no toca la base: el pool nunca llega a conectarse.
let app: FastifyInstance;
const pool = new pg.Pool({ max: 1 });

beforeAll(async () => {
  const services = await createServices(pool, loadConfig({ NODE_ENV: 'test' }), systemClock);
  app = await buildApp({ version: '0.1.0', checks: {}, lifecycle: { draining: false }, api: services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('contrato OpenAPI', () => {
  it('es OpenAPI 3.1 válido', async () => {
    const document = app.swagger() as Parameters<typeof validate>[0];
    const result = await validate(structuredClone(document));
    expect(result.valid, result.valid ? '' : compileErrors(result)).toBe(true);
  });

  it('el archivo publicado está al día con las rutas', () => {
    const published = readFileSync(join(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'generated', 'openapi.json'), 'utf8');
    expect(JSON.parse(published)).toEqual(JSON.parse(JSON.stringify(app.swagger())));
  });

  it('cada ruta protegida declara el esquema bearer y sus errores en Problem Details', () => {
    type Doc = { paths: Record<string, Record<string, { security?: unknown; responses: Record<string, unknown> }>> };
    const doc = JSON.parse(JSON.stringify(app.swagger())) as Doc;
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const statuses = Object.keys(operation.responses);
        expect(statuses.some((s) => s.startsWith('4')), `${method} ${path} documenta errores`).toBe(true);
        if (!path.startsWith('/v1/auth/')) expect(operation.security, `${method} ${path} exige token`).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  it('se publica en /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ openapi: string }>().openapi).toBe('3.1.0');
  });
});
