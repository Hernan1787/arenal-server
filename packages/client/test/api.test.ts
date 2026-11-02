import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ArenalApi } from '../src/api.js';

const session = (n: number) => ({
  user: { id: 'u1', displayName: 'Ana', role: 'player' },
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArenalApi', () => {
  it('cuando el access token vence, lo renueva una sola vez y repite la solicitud', async () => {
    const calls: { path: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const auth = new Headers(init.headers).get('authorization');
        calls.push({ path, auth });
        if (path === '/v1/auth/register') return Promise.resolve(json(201, session(1)));
        if (path === '/v1/auth/refresh') return Promise.resolve(json(200, session(2)));
        if (auth === 'Bearer access-1') return Promise.resolve(json(401, { code: 'UNAUTHORIZED' }));
        return Promise.resolve(json(201, { ticket: 't-ok' }));
      }),
    );
    const api = new ArenalApi('http://arenal.test');
    await api.register({ email: 'ana@ejemplo.com', password: 'clave-larga', displayName: 'Ana' });

    const tickets = await Promise.all([api.realtimeTicket(), api.realtimeTicket()]);

    expect(tickets).toEqual(['t-ok', 't-ok']);
    expect(calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(1);
    expect(api.userToken).toBe('access-2');
  });

  it('si la renovación tampoco sirve, entrega el error sin quedarse en un ciclo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        if (path === '/v1/auth/register') return Promise.resolve(json(201, session(1)));
        if (path === '/v1/auth/refresh') return Promise.resolve(json(200, session(2)));
        return Promise.resolve(json(401, { code: 'UNAUTHORIZED' }));
      }),
    );
    const api = new ArenalApi('http://arenal.test');
    await api.register({ email: 'ana@ejemplo.com', password: 'clave-larga', displayName: 'Ana' });

    await expect(api.realtimeTicket()).rejects.toBeInstanceOf(ApiError);
  });
});
