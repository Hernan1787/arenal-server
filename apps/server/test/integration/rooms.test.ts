import { describe, expect, it } from 'vitest';
import { expectProblem, registerUser, registerUsers, useHarness, type TestUser } from './harness.js';

const h = useHarness();

interface RoomBody {
  id: string;
  status: string;
  inviteCode: string | null;
  hostId: string;
  matchId: string | null;
  members: { userId: string; ready: boolean }[];
}

const createRoom = async (user: TestUser, visibility: 'public' | 'private', capacity = 4): Promise<RoomBody> => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/rooms',
    headers: user.auth,
    payload: { visibility, capacity },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json<RoomBody>();
};

const join = (user: TestUser, roomId: string) =>
  h.app.inject({ method: 'POST', url: `/v1/rooms/${roomId}/join`, headers: user.auth });

const ready = (user: TestUser, roomId: string, value = true) =>
  h.app.inject({ method: 'PUT', url: `/v1/rooms/${roomId}/ready`, headers: user.auth, payload: { ready: value } });

describe('salas públicas', () => {
  it('se crea, aparece en la lista, otro se une y arranca cuando todos están listos', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const room = await createRoom(ana, 'public');
    expect(room).toMatchObject({ status: 'waiting', hostId: ana.id, inviteCode: null });

    const list = await h.app.inject({ method: 'GET', url: '/v1/rooms', headers: beto.auth });
    expect(list.json<{ items: { id: string }[] }>().items.map((r) => r.id)).toEqual([room.id]);

    expect((await join(beto, room.id)).statusCode).toBe(200);

    // Uno solo listo no alcanza.
    expect((await ready(ana, room.id)).json<RoomBody>().status).toBe('waiting');
    const started = (await ready(beto, room.id)).json<RoomBody>();
    expect(started.status).toBe('started');
    expect(started.matchId).toEqual(expect.any(String));

    const { rows } = await h.db.query<{ user_id: string }>(
      'SELECT user_id FROM match_players WHERE match_id = $1 AND active',
      [started.matchId],
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([ana.id, beto.id].sort());
    // La sala arrancada ya no aparece en la lista.
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/rooms', headers: beto.auth })).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it('una sola persona lista no arranca la sala', async () => {
    const ana = await registerUser(h.app);
    const room = await createRoom(ana, 'public');
    expect((await ready(ana, room.id)).json<RoomBody>().status).toBe('waiting');
  });

  it('cuando alguien se une, todos deben volver a marcar listo', async () => {
    const [ana, beto, caro] = await registerUsers(h.app, 3);
    if (ana === undefined || beto === undefined || caro === undefined) throw new Error('faltan usuarios');
    const room = await createRoom(ana, 'public');
    await join(beto, room.id);
    await ready(ana, room.id);
    const afterJoin = (await join(caro, room.id)).json<RoomBody>();
    expect(afterJoin.members.every((m) => !m.ready)).toBe(true);
  });

  it('si sale el anfitrión, pasa al miembro más antiguo; si sale el último, la sala se cierra', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const room = await createRoom(ana, 'public');
    await join(beto, room.id);

    expect(
      (await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/leave`, headers: ana.auth })).statusCode,
    ).toBe(204);
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/rooms/${room.id}`, headers: beto.auth })).json<RoomBody>().hostId,
    ).toBe(beto.id);

    await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/leave`, headers: beto.auth });
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/rooms/${room.id}`, headers: beto.auth })).json<RoomBody>().status,
    ).toBe('closed');
  });
});

describe('salas privadas', () => {
  it('se entra con el código; no aparece en la lista y quien no es miembro no la ve', async () => {
    const [ana, beto, caro] = await registerUsers(h.app, 3);
    if (ana === undefined || beto === undefined || caro === undefined) throw new Error('faltan usuarios');
    const room = await createRoom(ana, 'private');
    expect(room.inviteCode).toMatch(/^[A-Z2-9]{8}$/);

    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/rooms', headers: beto.auth })).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    expectProblem(await h.app.inject({ method: 'GET', url: `/v1/rooms/${room.id}`, headers: beto.auth }), 404);
    expectProblem(await join(beto, room.id), 404);

    const byCode = await h.app.inject({
      method: 'POST',
      url: '/v1/rooms/join-by-code',
      headers: beto.auth,
      payload: { inviteCode: (room.inviteCode ?? '').toLowerCase() },
    });
    expect(byCode.statusCode).toBe(200);
    expect(byCode.json<RoomBody>().inviteCode).toBe(room.inviteCode);

    expectProblem(
      await h.app.inject({
        method: 'POST',
        url: '/v1/rooms/join-by-code',
        headers: caro.auth,
        payload: { inviteCode: 'ZZZZZZZZ' },
      }),
      404,
    );
  });
});

describe('capacidad y exclusividad', () => {
  it('aunque 10 se unan a la vez a una sala de 4, entran exactamente 3', async () => {
    const host = await registerUser(h.app);
    const room = await createRoom(host, 'public', 4);
    const others = await registerUsers(h.app, 10);

    const results = await Promise.all(others.map((u) => join(u, room.id)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json<{ code: string }>().code).toBe('ROOM_FULL');

    const { rows } = await h.db.query<{ member_count: number; members: string }>(
      'SELECT member_count, (SELECT count(*) FROM room_members WHERE room_id = $1) AS members FROM rooms WHERE id = $1',
      [room.id],
    );
    expect(rows[0]).toEqual({ member_count: 4, members: '4' });
  });

  it('nadie puede estar en dos salas, ni en sala y cola a la vez', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const first = await createRoom(ana, 'public');
    const second = await createRoom(beto, 'public');

    expectProblem(
      await h.app.inject({ method: 'POST', url: '/v1/rooms', headers: ana.auth, payload: { visibility: 'public' } }),
      409,
      'ALREADY_IN_ROOM',
    );
    expectProblem(await join(ana, second.id), 409, 'ALREADY_IN_ROOM');
    expectProblem(
      await h.app.inject({ method: 'POST', url: '/v1/matchmaking/ticket', headers: ana.auth }),
      409,
      'ALREADY_IN_ROOM',
    );
    expect(first.id).not.toBe(second.id);
  });

  it('quien está jugando no puede crear ni unirse a salas', async () => {
    const [ana, beto, caro] = await registerUsers(h.app, 3);
    if (ana === undefined || beto === undefined || caro === undefined) throw new Error('faltan usuarios');
    const room = await createRoom(ana, 'public');
    await join(beto, room.id);
    await ready(ana, room.id);
    await ready(beto, room.id);

    const other = await createRoom(caro, 'public');
    expectProblem(await join(ana, other.id), 409, 'ALREADY_IN_MATCH');
  });
});
