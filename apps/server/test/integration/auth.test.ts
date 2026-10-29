import { SignJWT, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { expectProblem, registerUser, useHarness } from './harness.js';

const h = useHarness();

describe('registro e inicio de sesión', () => {
  it('registra, guarda la contraseña con Argon2id y entrega una sesión', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'Ana@Ejemplo.COM', password: 'una-clave-larga', displayName: 'Ana' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ user: { email: string; role: string }; tokenType: string; expiresIn: number }>();
    expect(body.user).toMatchObject({ email: 'ana@ejemplo.com', role: 'player' });
    expect(body).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });

    const { rows } = await h.db.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(res.body).not.toContain('una-clave-larga');
  });

  it('rechaza un correo repetido sin importar mayúsculas', async () => {
    const user = await registerUser(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: user.email.toUpperCase(), password: 'otra-clave-larga', displayName: 'Copia' },
    });
    expectProblem(res, 409, 'EMAIL_TAKEN');
  });

  it('valida el cuerpo sin repetir lo que mandó el cliente', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'malo', password: 'corta', displayName: 'X', admin: true },
    });
    const problem = expectProblem(res, 400);
    expect(problem['type']).toBe('/problems/validation-error');
    expect(res.body).not.toContain('corta');
  });

  it('el login falla igual si el correo no existe o la clave está mal', async () => {
    const user = await registerUser(h.app);
    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.9.0.1',
      payload: { email: user.email, password: 'no-es-la-clave' },
    });
    const unknownEmail = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.9.0.1',
      payload: { email: 'nadie@ejemplo.com', password: 'no-es-la-clave' },
    });
    expect(expectProblem(wrongPassword, 401)['detail']).toBe(expectProblem(unknownEmail, 401)['detail']);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.9.0.1',
      payload: { email: user.email, password: user.password },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('limita los intentos de login por IP con 429, Retry-After y Problem Details', async () => {
    const attempt = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: '10.9.9.9',
        payload: { email: 'nadie@ejemplo.com', password: 'adivinando' },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expectProblem(blocked, 429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('access token', () => {
  it('sin token responde 401 con WWW-Authenticate', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me' });
    expectProblem(res, 401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('con token devuelve el perfil y permite cambiar el nombre', async () => {
    const user = await registerUser(h.app, 'Beto');
    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: user.auth });
    expect(me.json()).toMatchObject({ id: user.id, displayName: 'Beto' });

    const patched = await h.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: user.auth,
      payload: { displayName: 'Beto Volcán' },
    });
    expect(patched.json()).toMatchObject({ displayName: 'Beto Volcán' });
  });

  it('rechaza un token alterado o firmado con otra llave', async () => {
    const user = await registerUser(h.app);
    const [header, payload, signature] = user.accessToken.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: user.id, role: 'admin' })).toString('base64url');
    const tampered = `${header ?? ''}.${forgedPayload}.${signature ?? ''}`;
    expectProblem(await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tampered}` } }), 401);

    const { privateKey } = await generateKeyPair('ES256');
    const foreign = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(user.id)
      .setIssuer('arenal')
      .setAudience('arenal-api')
      .setExpirationTime('5m')
      .sign(privateKey);
    expectProblem(await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${foreign}` } }), 401);
    expect(payload).toBeDefined();
  });

  it('una cuenta suspendida queda fuera de inmediato, aunque su token siga vigente', async () => {
    const user = await registerUser(h.app);
    await h.db.query('UPDATE users SET suspended_at = now() WHERE id = $1', [user.id]);
    expectProblem(await h.app.inject({ method: 'GET', url: '/v1/me', headers: user.auth }), 403, 'ACCOUNT_SUSPENDED');
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.9.0.2',
      payload: { email: user.email, password: user.password },
    });
    expectProblem(login, 403, 'ACCOUNT_SUSPENDED');
  });
});

describe('refresh token rotativo', () => {
  const refresh = (token: string) =>
    h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: token } });

  it('cada renovación entrega un par nuevo y el refresh usado deja de servir', async () => {
    const user = await registerUser(h.app);
    const first = await refresh(user.refreshToken);
    expect(first.statusCode).toBe(200);
    const next = first.json<{ refreshToken: string; accessToken: string }>();
    expect(next.refreshToken).not.toBe(user.refreshToken);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${next.accessToken}` } })).statusCode).toBe(200);
    expect((await refresh(next.refreshToken)).statusCode).toBe(200);
  });

  it('si alguien reusa un refresh viejo, se revoca toda la sesión', async () => {
    const user = await registerUser(h.app);
    const rotated = (await refresh(user.refreshToken)).json<{ refreshToken: string }>();

    const reuse = await refresh(user.refreshToken);
    expect(expectProblem(reuse, 401)['detail']).toContain('ya se había usado');
    // El token legítimo más nuevo también quedó revocado.
    expectProblem(await refresh(rotated.refreshToken), 401);
  });

  it('dos renovaciones simultáneas con el mismo token: solo una gana', async () => {
    const user = await registerUser(h.app);
    const results = await Promise.all([refresh(user.refreshToken), refresh(user.refreshToken)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('cerrar sesión invalida el refresh token', async () => {
    const user = await registerUser(h.app);
    const logout = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: user.refreshToken } });
    expect(logout.statusCode).toBe(204);
    expectProblem(await refresh(user.refreshToken), 401);
  });

  it('solo se guarda el hash del refresh token', async () => {
    const user = await registerUser(h.app);
    const { rows } = await h.db.query<{ token_hash: Buffer }>('SELECT token_hash FROM refresh_tokens');
    expect(rows.every((r) => !r.token_hash.toString('utf8').includes(user.refreshToken))).toBe(true);
    expect(rows[0]?.token_hash).toHaveLength(32);
  });
});
