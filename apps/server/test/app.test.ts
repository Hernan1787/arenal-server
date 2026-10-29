import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type HealthCheck, type Lifecycle } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { serializeRequest } from '../src/http/logging.js';
import { cryptoRng } from '../src/rng.js';

const okCheck: HealthCheck = () => Promise.resolve();
const failingCheck: HealthCheck = () => Promise.reject(new Error('caído'));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function app(checks: Record<string, HealthCheck>, lifecycle: Lifecycle = { draining: false }) {
  const instance = await buildApp({ version: 'test', checks, lifecycle, checkTimeoutMs: 100 });
  close = () => instance.close();
  return instance;
}

describe('sondas de salud', () => {
  it('/health/live responde 200 siempre que el proceso viva', async () => {
    const res = await (await app({ postgres: failingCheck })).inject('/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: 'test' });
  });

  it('/health/ready responde 200 cuando Postgres y Redis responden', async () => {
    const res = await (await app({ postgres: okCheck, redis: okCheck })).inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('/health/ready responde 503 en Problem Details si una dependencia falla, sin exponer el error', async () => {
    const res = await (await app({ postgres: okCheck, redis: failingCheck })).inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: '/problems/not-ready', status: 503, checks: { redis: 'fail' } });
    expect(res.body).not.toContain('caído');
  });

  it('/health/ready responde 503 si la dependencia se cuelga', async () => {
    const hanging: HealthCheck = () => new Promise(() => undefined);
    const res = await (await app({ redis: hanging })).inject('/health/ready');
    expect(res.statusCode).toBe(503);
  });

  it('/health/ready responde 503 mientras la réplica drena', async () => {
    const res = await (await app({ postgres: okCheck }, { draining: true })).inject('/health/ready');
    expect(res.statusCode).toBe(503);
  });
});

describe('errores y encabezados', () => {
  it('una ruta que no existe responde 404 en Problem Details', async () => {
    const res = await (await app({})).inject('/no-existe?ticket=secreto');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: '/problems/not-found',
      title: 'No existe',
      status: 404,
      instance: '/no-existe',
    });
  });

  it('agrega los encabezados de seguridad', async () => {
    const res = await (await app({})).inject('/health/live');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('ignora un ID de solicitud que mande el cliente', async () => {
    const res = await (await app({})).inject({ url: '/health/live', headers: { 'request-id': 'inyectado' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('logs sin datos sensibles', () => {
  it('la URL se registra sin query string (ahí viaja el ticket)', () => {
    expect(serializeRequest({ id: 'r1', method: 'GET', url: '/v1/realtime?ticket=abc123' })).toEqual({
      id: 'r1',
      method: 'GET',
      path: '/v1/realtime',
    });
  });
});

describe('configuración', () => {
  it('usa valores por defecto razonables', () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(8080);
    expect(config.PG_SSL).toBe(false);
  });

  it('dice qué variable falla sin mostrar su valor', () => {
    expect(() => loadConfig({ PORT: 'no-es-numero-xyz' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'no-es-numero-xyz' });
    } catch (error) {
      expect(String(error)).toContain('PORT');
      expect(String(error)).not.toContain('no-es-numero-xyz');
    }
  });
});

describe('azar criptográfico', () => {
  it('devuelve enteros dentro del rango, ambos extremos incluidos', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = cryptoRng.int(15, 25);
      expect(Number.isInteger(n) && n >= 15 && n <= 25).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(11);
  });

  it('rechaza rangos inválidos', () => {
    expect(() => cryptoRng.int(5, 1)).toThrow(RangeError);
  });
});
