import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectProblem, registerUser, useHarness } from './harness.js';

// Las dos réplicas firman con la misma llave (como en Azure, donde sale de Key Vault): un token
// emitido por una sirve en la otra. Se genera en cada corrida; no queda en el repo.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const h = useHarness({
  env: {
    RATE_LIMIT_USER_PER_MINUTE: '3',
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  },
});

describe('límites de tasa compartidos', () => {
  it('el límite por usuario se cuenta entre todas las réplicas y responde 429 con Retry-After', async () => {
    const user = await registerUser(h.app);
    const other = await h.addReplica();
    const me = (app: typeof h.app) => app.inject({ method: 'GET', url: '/v1/me', headers: user.auth });

    expect((await me(h.app)).statusCode).toBe(200);
    expect((await me(other.app)).statusCode).toBe(200);
    expect((await me(h.app)).statusCode).toBe(200);
    const blocked = await me(other.app);
    expectProblem(blocked, 429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Otro usuario no comparte el contador.
    const someoneElse = await registerUser(h.app);
    expect((await other.app.inject({ method: 'GET', url: '/v1/me', headers: someoneElse.auth })).statusCode).toBe(200);
  });

  it('cada ruta lleva su propio contador', async () => {
    const user = await registerUser(h.app);
    for (let i = 0; i < 3; i++) {
      await h.app.inject({ method: 'GET', url: '/v1/me', headers: user.auth });
    }
    const rooms = await h.app.inject({ method: 'GET', url: '/v1/rooms', headers: user.auth });
    expect(rooms.statusCode).toBe(200);
  });
});
