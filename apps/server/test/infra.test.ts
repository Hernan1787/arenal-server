import type { AccessToken, TokenCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { entraPassword } from '../src/infra/postgres.js';

/** Credencial falsa que cuenta cuántos tokens entrega. */
function fakeCredential(lifetimeMs: number, now: () => number): TokenCredential & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getToken: (scopes) => {
      calls.push(String(scopes));
      const token: AccessToken = { token: `token-${calls.length}`, expiresOnTimestamp: now() + lifetimeMs };
      return Promise.resolve(token);
    },
  };
}

describe('contraseña de Postgres con Entra ID', () => {
  it('pide el token con la audiencia de Postgres y lo reusa mientras le queden más de 5 minutos', async () => {
    let clock = 0;
    const now = () => clock;
    const credential = fakeCredential(60 * 60_000, now);
    const password = entraPassword(credential, now);

    expect(await password()).toBe('token-1');
    clock += 50 * 60_000;
    expect(await password()).toBe('token-1');
    clock += 6 * 60_000; // quedan 4 minutos
    expect(await password()).toBe('token-2');
    expect(credential.calls).toEqual([
      'https://ossrdbms-aad.database.windows.net/.default',
      'https://ossrdbms-aad.database.windows.net/.default',
    ]);
  });

  it('falla si la identidad no entrega token', async () => {
    const password = entraPassword({ getToken: () => Promise.resolve(null) });
    await expect(password()).rejects.toThrow(/no entregó un token/);
  });
});

describe('configuración de Azure', () => {
  it('con identidad administrada exige TLS hacia Postgres y Redis', () => {
    expect(() => loadConfig({ PG_AUTH: 'entra' })).toThrow(ConfigError);
    expect(() => loadConfig({ REDIS_AUTH: 'entra' })).toThrow(ConfigError);
    const config = loadConfig({
      PG_AUTH: 'entra',
      PG_SSL: 'true',
      REDIS_AUTH: 'entra',
      REDIS_TLS: 'true',
      AZURE_CLIENT_ID: '00000000-0000-4000-8000-000000000000',
    });
    expect(config.PG_AUTH).toBe('entra');
    expect(config.REDIS_AUTH).toBe('entra');
  });

  it('el nombre de la réplica sale del hostname y rechaza caracteres raros', () => {
    expect(loadConfig({}).REPLICA_ID.length).toBeGreaterThan(0);
    expect(() => loadConfig({ REPLICA_ID: 'a b|c' })).toThrow(ConfigError);
  });
});

describe('telemetría', () => {
  it('sin cadena de conexión de Application Insights no arranca nada', async () => {
    const { startTelemetry, flushTelemetry } = await import('../src/observability/telemetry.js');
    expect(await startTelemetry({})).toBe(false);
    expect(await startTelemetry({ APPLICATIONINSIGHTS_CONNECTION_STRING: '' })).toBe(false);
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('no traza las sondas de salud ni guarda argumentos de Redis', async () => {
    const { ignoreIncomingRequest, redisStatement } = await import('../src/observability/telemetry.js');
    expect(ignoreIncomingRequest({ url: '/health/ready' })).toBe(true);
    expect(ignoreIncomingRequest({ url: '/v1/rooms' })).toBe(false);
    expect(redisStatement('GETDEL')).toBe('GETDEL');
  });
});
