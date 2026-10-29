import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@arenal/contracts';
import { describe, expect, it } from 'vitest';
import { setUserRole } from '../../src/admin/roles.js';
import { AppError } from '../../src/errors.js';
import { expectProblem, registerUser, registerUsers, useHarness, type TestUser } from './harness.js';
import { ticketFor, TestSocket } from './ws-client.js';

const h = useHarness({ realtime: true });

type EventMsg = Extract<ServerMessage, { type: 'event' }>;
const isEvent =
  (type: string) =>
  (m: ServerMessage): m is EventMsg =>
    m.type === 'event' && m.event.type === type;

const operator = { actorId: null, reason: 'Preparación de la prueba', requestId: null };

async function registerAdmin(): Promise<TestUser> {
  const user = await registerUser(h.app, 'Admin');
  await setUserRole(h.db, user.email, 'admin', operator);
  return user;
}

const connect = async (user: TestUser, baseUrl = h.baseUrl): Promise<TestSocket> =>
  TestSocket.open(baseUrl, await ticketFor(h.app, user));

/** Arma una partida de 2 por sala y devuelve su ID con los jugadores. */
async function startMatch(): Promise<{ matchId: string; ana: TestUser; beto: TestUser }> {
  const [ana, beto] = await registerUsers(h.app, 2);
  if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
  const room = (
    await h.app.inject({ method: 'POST', url: '/v1/rooms', headers: ana.auth, payload: { visibility: 'public' } })
  ).json<{ id: string }>();
  await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/join`, headers: beto.auth });
  await h.app.inject({ method: 'PUT', url: `/v1/rooms/${room.id}/ready`, headers: ana.auth, payload: { ready: true } });
  const started = await h.app.inject({
    method: 'PUT',
    url: `/v1/rooms/${room.id}/ready`,
    headers: beto.auth,
    payload: { ready: true },
  });
  return { matchId: started.json<{ matchId: string }>().matchId, ana, beto };
}

/** `reason: null` manda el cuerpo sin motivo. */
const post = (url: string, user: TestUser, reason: string | null = 'Motivo de prueba') =>
  h.app.inject({
    method: 'POST',
    url,
    headers: user.auth,
    payload: reason === null ? {} : { reason },
  });

const get = (url: string, user: TestUser) => h.app.inject({ method: 'GET', url, headers: user.auth });

interface AuditItem {
  action: string;
  targetId: string;
  reason: string;
  actor: { id: string } | null;
  requestId: string | null;
  details: Record<string, unknown>;
}
const auditFor = async (admin: TestUser, targetId: string): Promise<AuditItem[]> =>
  (await get(`/v1/admin/audit?targetId=${targetId}`, admin)).json<{ items: AuditItem[] }>().items;

describe('autorización', () => {
  it('un jugador recibe 403 ADMIN_ONLY en todas las rutas de administración; sin token, 401', async () => {
    const player = await registerUser(h.app);
    const id = randomUUID();
    const routes: [string, string][] = [
      ['GET', '/v1/admin/matches'],
      ['GET', '/v1/admin/connections'],
      ['GET', '/v1/admin/audit'],
      ['GET', `/v1/admin/users/${id}`],
      ['POST', `/v1/admin/matches/${id}/terminate`],
      ['POST', `/v1/admin/users/${id}/suspend`],
      ['POST', `/v1/admin/users/${id}/reinstate`],
    ];
    for (const [method, url] of routes) {
      const payload = method === 'POST' ? { reason: 'Intento sin permiso' } : undefined;
      expectProblem(
        await h.app.inject({ method: method as 'GET', url, headers: player.auth, ...(payload && { payload }) }),
        403,
        'ADMIN_ONLY',
      );
      expectProblem(await h.app.inject({ method: method as 'GET', url, ...(payload && { payload }) }), 401);
    }
  });

  it('el rol se lee de la base: quitarlo aplica de inmediato aunque el token siga vigente', async () => {
    const admin = await registerAdmin();
    expect((await get('/v1/admin/matches', admin)).statusCode).toBe(200);
    await setUserRole(h.db, admin.email, 'player', operator);
    expectProblem(await get('/v1/admin/matches', admin), 403, 'ADMIN_ONLY');
  });

  it('dar el rol desde la línea de comandos queda auditado con actor de operador', async () => {
    const user = await registerUser(h.app);
    expect(await setUserRole(h.db, user.email, 'admin', operator)).toEqual({ userId: user.id, changed: true });
    expect(await setUserRole(h.db, user.email.toUpperCase(), 'admin', operator)).toEqual({
      userId: user.id,
      changed: false,
    });
    await expect(setUserRole(h.db, 'nadie@ejemplo.com', 'admin', operator)).rejects.toBeInstanceOf(AppError);

    const [entry] = await auditFor(user, user.id);
    expect(entry).toMatchObject({ action: 'user.grant_admin', actor: null, details: { previousRole: 'player' } });
  });
});

describe('partidas en curso', () => {
  it('lista las partidas con la conexión de cada jugador, sin manos, mazo ni límite', async () => {
    const admin = await registerAdmin();
    const { matchId, ana, beto } = await startMatch();
    const socket = await connect(ana);
    await socket.next((m) => m.type === 'snapshot');

    const res = await get('/v1/admin/matches', admin);
    expect(res.statusCode).toBe(200);
    const [match] = res.json<{
      items: { matchId: string; players: { id: string; connections: number; inGame: boolean }[] }[];
    }>().items;
    expect(match?.matchId).toBe(matchId);
    const byId = new Map(match?.players.map((p) => [p.id, p]));
    expect(byId.get(ana.id)).toMatchObject({ connections: 1, inGame: true });
    expect(byId.get(beto.id)).toMatchObject({ connections: 0, inGame: true });

    const loaded = await h.services.store.load(matchId);
    const secrets = [
      ...(loaded?.state.players.flatMap((p) => p.hand.map((c) => c.id)) ?? []),
      ...(loaded?.state.drawPile.map((c) => c.id) ?? []),
    ];
    expect(secrets.length).toBeGreaterThan(0);
    for (const id of secrets) expect(res.body).not.toContain(id);
    expect(res.body).not.toMatch(/"(limit|hand|drawPile)"/);
    await socket.close();
  });

  it('ve las conexiones de todas las réplicas', async () => {
    const admin = await registerAdmin();
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const other = await h.addReplica();
    const a1 = await connect(ana);
    const a2 = await connect(ana, other.baseUrl);
    const b = await connect(beto, other.baseUrl);

    const res = await get('/v1/admin/connections', admin);
    expect(res.json()).toMatchObject({
      total: 3,
      truncated: false,
      replicas: [
        { replica: 'replica-1', connections: 1 },
        { replica: 'replica-2', connections: 2 },
      ],
      users: [
        { userId: ana.id, connections: 2, activeMatchId: null },
        { userId: beto.id, connections: 1 },
      ],
    });

    await Promise.all([a1.close(), a2.close(), b.close()]);
    await expect.poll(async () => (await get('/v1/admin/connections', admin)).json<{ total: number }>().total).toBe(0);
  });
});

describe('terminar una partida', () => {
  it('cierra la partida sin ganador, avisa por WebSocket, libera a los jugadores y queda auditada', async () => {
    const admin = await registerAdmin();
    const { matchId, ana, beto } = await startMatch();
    const sockets = [await connect(ana), await connect(beto)];
    for (const s of sockets) await s.next((m) => m.type === 'snapshot');

    const res = await post(`/v1/admin/matches/${matchId}/terminate`, admin, 'Partida trabada en pruebas');
    expect(res.statusCode).toBe(200);
    const { seq } = res.json<{ seq: number }>();
    expect(res.json()).toEqual({ matchId, seq, status: 'aborted' });

    for (const s of sockets) {
      const ended = await s.next(isEvent('MatchEnded'));
      expect(ended).toMatchObject({ seq, event: { type: 'MatchEnded', result: { kind: 'aborted', reason: 'admin' } } });
    }
    const { rows } = await h.db.query<{ status: string; finished_at: Date | null }>(
      'SELECT status, finished_at FROM matches WHERE id = $1',
      [matchId],
    );
    expect(rows[0]?.status).toBe('aborted');
    expect(rows[0]?.finished_at).not.toBeNull();
    expect((await get('/v1/admin/matches', admin)).json<{ items: unknown[] }>().items).toHaveLength(0);

    // Los jugadores quedan libres y la repetición ya está disponible.
    expect((await h.app.inject({ method: 'POST', url: '/v1/matchmaking/ticket', headers: ana.auth })).statusCode).toBe(
      202,
    );
    expect((await get(`/v1/matches/${matchId}/replay`, beto)).statusCode).toBe(200);
    const history = (await get('/v1/me/matches', beto)).json<{ items: { status: string }[] }>().items;
    expect(history[0]?.status).toBe('aborted');

    const [entry] = await auditFor(admin, matchId);
    expect(entry).toMatchObject({
      action: 'match.terminate',
      reason: 'Partida trabada en pruebas',
      actor: { id: admin.id },
      details: { seq, players: expect.arrayContaining([ana.id, beto.id]) as unknown },
    });
    expect(entry?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    for (const s of sockets) await s.close();
  });

  it('una partida terminada da 409, una que no existe 404 y sin motivo 400', async () => {
    const admin = await registerAdmin();
    const { matchId } = await startMatch();
    expect((await post(`/v1/admin/matches/${matchId}/terminate`, admin)).statusCode).toBe(200);
    expectProblem(await post(`/v1/admin/matches/${matchId}/terminate`, admin), 409, 'MATCH_FINISHED');
    expectProblem(await post(`/v1/admin/matches/${randomUUID()}/terminate`, admin), 404);
    expectProblem(await post(`/v1/admin/matches/${matchId}/terminate`, admin, null), 400);
    expectProblem(await post(`/v1/admin/matches/${matchId}/terminate`, admin, '  '), 400);
    expect(await auditFor(admin, matchId)).toHaveLength(1);
  });
});

describe('suspender un usuario', () => {
  it('cierra sus conexiones en otra réplica, abandona su partida y revoca sus sesiones', async () => {
    const admin = await registerAdmin();
    const { matchId, ana, beto } = await startMatch();
    const other = await h.addReplica();
    const anaSocket = await connect(ana, other.baseUrl);
    const betoSocket = await connect(beto);
    await anaSocket.next((m) => m.type === 'snapshot');
    await betoSocket.next((m) => m.type === 'snapshot');

    const res = await post(`/v1/admin/users/${ana.id}/suspend`, admin, 'Uso de bots');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ana.id, activeMatchId: null });
    expect(res.json<{ suspendedAt: string | null }>().suspendedAt).not.toBeNull();

    expect(await anaSocket.closed).toEqual({ code: 4003, reason: 'La cuenta fue suspendida' });
    // El rival no espera el periodo de gracia: Ana sale por abandono y Beto gana.
    expect(await betoSocket.next(isEvent('PlayerEliminated'))).toMatchObject({
      event: { playerId: ana.id, reason: 'abandon' },
    });
    expect(await betoSocket.next(isEvent('MatchEnded'))).toMatchObject({
      event: { result: { kind: 'winner', winner: beto.id } },
    });

    expectProblem(await get('/v1/me', ana), 403, 'ACCOUNT_SUSPENDED');
    expectProblem(
      await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: ana.refreshToken } }),
      401,
    );
    expectProblem(
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        remoteAddress: '10.9.9.9',
        payload: { email: ana.email, password: ana.password },
      }),
      403,
      'ACCOUNT_SUSPENDED',
    );

    const [entry] = await auditFor(admin, ana.id);
    expect(entry).toMatchObject({
      action: 'user.suspend',
      reason: 'Uso de bots',
      details: { activeMatchId: matchId, revokedSessions: 1, dequeued: false, leftRoomId: null },
    });
    await betoSocket.close();
  });

  it('lo saca de su sala (el anfitrión pasa al siguiente) y de la cola', async () => {
    const admin = await registerAdmin();
    const [host, guest, queued] = await registerUsers(h.app, 3);
    if (host === undefined || guest === undefined || queued === undefined) throw new Error('faltan usuarios');
    const room = (
      await h.app.inject({ method: 'POST', url: '/v1/rooms', headers: host.auth, payload: { visibility: 'public' } })
    ).json<{ id: string }>();
    await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/join`, headers: guest.auth });
    await h.app.inject({ method: 'POST', url: '/v1/matchmaking/ticket', headers: queued.auth });

    expect((await post(`/v1/admin/users/${host.id}/suspend`, admin)).statusCode).toBe(200);
    expect((await post(`/v1/admin/users/${queued.id}/suspend`, admin)).statusCode).toBe(200);

    const after = (await get(`/v1/rooms/${room.id}`, guest)).json<{ hostId: string; members: unknown[] }>();
    expect(after.hostId).toBe(guest.id);
    expect(after.members).toHaveLength(1);
    const { rowCount } = await h.db.query('SELECT 1 FROM matchmaking_tickets WHERE user_id = $1', [queued.id]);
    expect(rowCount).toBe(0);
    expect((await auditFor(admin, host.id))[0]?.details).toMatchObject({ leftRoomId: room.id });
    expect((await auditFor(admin, queued.id))[0]?.details).toMatchObject({ dequeued: true });
  });

  it('no se puede suspender a uno mismo ni dos veces; quitar la suspensión deja volver a entrar', async () => {
    const admin = await registerAdmin();
    const user = await registerUser(h.app);
    expectProblem(await post(`/v1/admin/users/${admin.id}/suspend`, admin), 409, 'CANNOT_SUSPEND_SELF');
    expectProblem(await post(`/v1/admin/users/${randomUUID()}/suspend`, admin), 404);
    expectProblem(await post(`/v1/admin/users/${user.id}/reinstate`, admin), 409, 'NOT_SUSPENDED');

    expect((await post(`/v1/admin/users/${user.id}/suspend`, admin)).statusCode).toBe(200);
    expectProblem(await post(`/v1/admin/users/${user.id}/suspend`, admin), 409, 'ALREADY_SUSPENDED');

    const reinstated = await post(`/v1/admin/users/${user.id}/reinstate`, admin, 'Apelación aceptada');
    expect(reinstated.json()).toMatchObject({ id: user.id, suspendedAt: null });
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.9.9.8',
      payload: { email: user.email, password: user.password },
    });
    expect(login.statusCode).toBe(200);

    expect((await auditFor(admin, user.id)).map((e) => e.action)).toEqual(['user.reinstate', 'user.suspend']);
  });
});

describe('registro de auditoría', () => {
  it('no se puede cambiar, borrar ni vaciar, ni siquiera con acceso directo a la base', async () => {
    const admin = await registerAdmin();
    const user = await registerUser(h.app);
    await post(`/v1/admin/users/${user.id}/suspend`, admin);

    await expect(h.db.query("UPDATE admin_audit SET reason = 'borrado'")).rejects.toThrow(/solo inserción/);
    await expect(h.db.query('DELETE FROM admin_audit')).rejects.toThrow(/solo inserción/);
    await expect(h.db.query('TRUNCATE admin_audit')).rejects.toThrow(/solo inserción/);
    expect(await auditFor(admin, user.id)).toHaveLength(1);
  });

  it('se pagina de la acción más nueva a la más vieja', async () => {
    const admin = await registerAdmin();
    const users = await registerUsers(h.app, 3);
    for (const u of users) await post(`/v1/admin/users/${u.id}/suspend`, admin);

    const first = (await get('/v1/admin/audit?limit=2', admin)).json<{ items: AuditItem[]; nextCursor: string }>();
    expect(first.items.map((e) => e.targetId)).toEqual([users[2]?.id, users[1]?.id]);
    const second = (await get(`/v1/admin/audit?limit=2&cursor=${first.nextCursor}`, admin)).json<{
      items: AuditItem[];
      nextCursor: string | null;
    }>();
    // La última es la de dar el rol al administrador.
    expect(second.items.map((e) => e.action)).toEqual(['user.suspend', 'user.grant_admin']);
    expect(second.nextCursor).toBeNull();
  });
});
