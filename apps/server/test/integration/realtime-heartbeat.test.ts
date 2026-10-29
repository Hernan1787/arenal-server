import { describe, expect, it } from 'vitest';
import { registerUser, registerUsers, useHarness } from './harness.js';
import { ticketFor, TestSocket } from './ws-client.js';

// Intervalos cortos para no esperar 30 segundos reales.
const h = useHarness({
  realtime: true,
  env: { WS_HEARTBEAT_INTERVAL_MS: '100', WS_HEARTBEAT_TIMEOUT_MS: '400', RATE_LIMIT_TICKETS_PER_MINUTE: '3' },
});

describe('heartbeat', () => {
  it('un cliente que no responde los ping se cierra con 4000', async () => {
    const user = await registerUser(h.app);
    const socket = await TestSocket.open(h.baseUrl, await ticketFor(h.app, user), { autoPong: false });
    const closed = await socket.closed;
    expect(closed.code).toBe(4000);
  });

  it('un cliente que responde los ping sigue conectado', async () => {
    const user = await registerUser(h.app);
    const socket = await TestSocket.open(h.baseUrl, await ticketFor(h.app, user));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(socket.ws.readyState).toBe(socket.ws.OPEN);
    await socket.close();
  });
});

describe('límite de tickets', () => {
  it('es por usuario: dos jugadores detrás de la misma IP no se bloquean entre sí', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const ask = (headers: { authorization: string }) =>
      h.app.inject({ method: 'POST', url: '/v1/realtime/tickets', headers, remoteAddress: '10.20.30.40' });

    for (let i = 0; i < 3; i++) expect((await ask(ana.auth)).statusCode).toBe(201);
    expect((await ask(ana.auth)).statusCode).toBe(429);
    expect((await ask(beto.auth)).statusCode).toBe(201);
  });
});
