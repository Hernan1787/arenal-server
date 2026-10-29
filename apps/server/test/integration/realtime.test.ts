import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@arenal/contracts';
import { describe, expect, it } from 'vitest';
import { registerUser, registerUsers, useHarness, type TestUser } from './harness.js';
import { handshakeStatus, play, ticketFor, TestSocket } from './ws-client.js';

const h = useHarness({ realtime: true, env: { TURN_TIMEOUT_MS: '30000', DISCONNECT_GRACE_MS: '60000' } });

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type Ack = Extract<ServerMessage, { type: 'ack' }>;
type ErrorMsg = Extract<ServerMessage, { type: 'error' }>;

const isSnapshot = (m: ServerMessage): m is Snapshot => m.type === 'snapshot';
const isAck =
  (id: string) =>
  (m: ServerMessage): m is Ack =>
    m.type === 'ack' && m.id === id;
const isError = (m: ServerMessage): m is ErrorMsg => m.type === 'error';

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
  const started = (
    await h.app.inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/ready`,
      headers: beto.auth,
      payload: { ready: true },
    })
  ).json<{ matchId: string }>();
  return { matchId: started.matchId, ana, beto };
}

/** Quién juega y con qué carta, leído del estado completo (solo para preparar la prueba). */
async function turnOf(matchId: string): Promise<{ playerId: string; cardId: string; seq: number; hand: string[] }> {
  const loaded = await h.services.store.load(matchId);
  const playerId = loaded?.state.currentPlayer ?? null;
  const hand = loaded?.state.players.find((p) => p.id === playerId)?.hand.map((c) => c.id) ?? [];
  const cardId = hand[0];
  if (loaded === undefined || playerId === null || cardId === undefined) throw new Error('sin turno');
  return { playerId, cardId, seq: loaded.row.seq, hand };
}

describe('handshake', () => {
  it('sin ticket, con un ticket inventado o reusado: 401 sin abrir el socket', async () => {
    const user = await registerUser(h.app);
    expect(await handshakeStatus(h.baseUrl, '')).toBe(401);
    expect(await handshakeStatus(h.baseUrl, `?ticket=${'x'.repeat(43)}`)).toBe(401);

    const ticket = await ticketFor(h.app, user);
    expect(await handshakeStatus(h.baseUrl, `?ticket=${ticket}`)).toBe(101);
    expect(await handshakeStatus(h.baseUrl, `?ticket=${ticket}`)).toBe(401);
  });

  it('un origen de navegador que no está en la lista: 403', async () => {
    const user = await registerUser(h.app);
    expect(
      await handshakeStatus(h.baseUrl, `?ticket=${await ticketFor(h.app, user)}`, {
        origin: 'https://malicioso.example',
      }),
    ).toBe(403);
    expect(
      await handshakeStatus(h.baseUrl, `?ticket=${await ticketFor(h.app, user)}`, { origin: 'http://localhost:8080' }),
    ).toBe(101);
  });

  it('una cuenta suspendida no puede conectarse aunque tenga ticket', async () => {
    const user = await registerUser(h.app);
    const ticket = await ticketFor(h.app, user);
    await h.db.query('UPDATE users SET suspended_at = now() WHERE id = $1', [user.id]);
    expect(await handshakeStatus(h.baseUrl, `?ticket=${ticket}`)).toBe(403);
  });

  it('el ticket vence', async () => {
    const user = await registerUser(h.app);
    const ticket = await ticketFor(h.app, user);
    // Vencerlo en Redis equivale a dejar pasar sus 30 segundos.
    const keys = await h.redis.keys('arenal:ticket:*');
    for (const k of keys) await h.redis.pExpire(k, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await handshakeStatus(h.baseUrl, `?ticket=${ticket}`)).toBe(401);
  });
});

describe('estado y eventos', () => {
  it('al conectarse recibe el snapshot de su partida; si arranca una partida estando conectado, también', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const socket = await connect(ana);

    const room = (
      await h.app.inject({ method: 'POST', url: '/v1/rooms', headers: ana.auth, payload: { visibility: 'public' } })
    ).json<{ id: string }>();
    await h.app.inject({ method: 'POST', url: `/v1/rooms/${room.id}/join`, headers: beto.auth });
    await h.app.inject({
      method: 'PUT',
      url: `/v1/rooms/${room.id}/ready`,
      headers: ana.auth,
      payload: { ready: true },
    });
    const { matchId } = (
      await h.app.inject({
        method: 'PUT',
        url: `/v1/rooms/${room.id}/ready`,
        headers: beto.auth,
        payload: { ready: true },
      })
    ).json<{ matchId: string }>();

    const pushed = (await socket.next(isSnapshot)) as Snapshot;
    expect(pushed.matchId).toBe(matchId);
    expect(pushed.view.you?.id).toBe(ana.id);

    const late = await connect(beto);
    expect(((await late.next(isSnapshot)) as Snapshot).matchId).toBe(matchId);
    await Promise.all([socket.close(), late.close()]);
  });

  it('una jugada: ack para quien juega y eventos consecutivos para los dos, sin la carta robada ajena', async () => {
    const { matchId, ana, beto } = await startMatch();
    const [sa, sb] = await Promise.all([connect(ana), connect(beto)]);
    const snapA = (await sa.next(isSnapshot)) as Snapshot;
    await sb.next(isSnapshot);

    const turn = await turnOf(matchId);
    const [player, other] = turn.playerId === ana.id ? [sa, sb] : [sb, sa];
    const moveId = randomUUID();
    player.send(play(matchId, turn.cardId, snapA.seq, moveId));
    const ack = (await player.next(isAck(moveId))) as Ack;
    expect(ack).toMatchObject({ duplicate: false });
    expect(ack.seq).toBeGreaterThan(snapA.seq);

    for (const socket of [player, other]) {
      const events = await socket.eventsUpTo(ack.seq);
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: ack.seq - snapA.seq }, (_, i) => snapA.seq + i + 1),
      );
    }
    const drawnByPlayer = (s: TestSocket) =>
      s.received.find((m) => m.type === 'event' && m.event.type === 'CardDrawn' && m.event.playerId === turn.playerId);
    const mine = drawnByPlayer(player);
    const theirs = drawnByPlayer(other);
    expect(mine?.type === 'event' && mine.event.type === 'CardDrawn' ? mine.event.card : undefined).toBeDefined();
    expect(
      theirs?.type === 'event' && theirs.event.type === 'CardDrawn' ? theirs.event.card : 'no-llegó',
    ).toBeUndefined();
    await Promise.all([sa.close(), sb.close()]);
  });

  it('nunca le llega a un jugador una carta que el otro tiene en la mano', async () => {
    const { matchId, ana, beto } = await startMatch();
    const [sa, sb] = await Promise.all([connect(ana), connect(beto)]);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    for (let i = 0; i < 6; i++) {
      const turn = await turnOf(matchId);
      const socket = turn.playerId === ana.id ? sa : sb;
      const id = randomUUID();
      socket.send(play(matchId, turn.cardId, turn.seq, id));
      await socket.next(isAck(id));
    }
    const finalSeq = (await turnOf(matchId)).seq;
    await Promise.all([sa.eventsUpTo(finalSeq), sb.eventsUpTo(finalSeq)]);

    const loaded = await h.services.store.load(matchId);
    for (const [socket, rival] of [
      [sa, beto.id],
      [sb, ana.id],
    ] as const) {
      const rivalHand = loaded?.state.players.find((p) => p.id === rival)?.hand.map((c) => c.id) ?? [];
      const everything = JSON.stringify(socket.received);
      for (const id of rivalHand) expect(everything).not.toContain(id);
      expect(everything).not.toMatch(/"limit":/);
    }
    await Promise.all([sa.close(), sb.close()]);
  });
});

describe('errores tipados sin cortar la partida', () => {
  it('JSON roto, versión desconocida y esquema inválido reciben error y la conexión sigue', async () => {
    const { matchId, ana } = await startMatch();
    const socket = await connect(ana);
    const snap = (await socket.next(isSnapshot)) as Snapshot;

    socket.sendRaw('{esto no es json');
    expect(((await socket.next(isError)) as ErrorMsg).code).toBe('INVALID_MESSAGE');
    socket.send({ ...play(matchId, 'c_aaaaaa', snap.seq), v: 2 });
    expect(((await socket.next(isError)) as ErrorMsg).code).toBe('UNSUPPORTED_VERSION');
    socket.send({ ...play(matchId, 'c_aaaaaa', snap.seq), payload: { cardId: 'c_aaaaaa', points: 99 } });
    expect(((await socket.next(isError)) as ErrorMsg).code).toBe('INVALID_MESSAGE');

    socket.send({ v: 1, type: 'resume', id: randomUUID(), matchId, lastSeq: snap.seq });
    expect(((await socket.next(isSnapshot)) as Snapshot).seq).toBe(snap.seq);
    await socket.close();
  });

  it('fuera de turno, versión vieja y reenvío del mismo moveId', async () => {
    const { matchId, ana, beto } = await startMatch();
    const [sa, sb] = await Promise.all([connect(ana), connect(beto)]);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    const turn = await turnOf(matchId);
    const [player, other] = turn.playerId === ana.id ? [sa, sb] : [sb, sa];

    other.send(play(matchId, turn.cardId, turn.seq));
    expect(((await other.next(isError)) as ErrorMsg).code).toBe('NOT_YOUR_TURN');

    player.send(play(matchId, turn.cardId, turn.seq - 1));
    const stale = (await player.next(isError)) as ErrorMsg;
    expect(stale).toMatchObject({ code: 'STALE_STATE', retryable: true });

    const moveId = randomUUID();
    player.send(play(matchId, turn.cardId, turn.seq, moveId));
    const first = (await player.next(isAck(moveId))) as Ack;
    player.send(play(matchId, turn.cardId, turn.seq, moveId));
    const again = (await player.next(isAck(moveId))) as Ack;
    expect(again).toMatchObject({ duplicate: true, seq: first.seq });
    await Promise.all([sa.close(), sb.close()]);
  });

  it('un mensaje de más de 4 KB cierra con 1009', async () => {
    const user = await registerUser(h.app);
    const socket = await connect(user);
    socket.sendRaw('x'.repeat(5_000));
    expect((await socket.closed).code).toBe(1009);
  });

  it('una ráfaga de mensajes recibe RATE_LIMITED', async () => {
    const user = await registerUser(h.app);
    const socket = await connect(user);
    for (let i = 0; i < 40; i++) socket.sendRaw('{}');
    const limited = await socket.next((m) => m.type === 'error' && m.code === 'RATE_LIMITED');
    expect(limited).toMatchObject({ retryable: true });
    await socket.close();
  });

  it('una cuarta conexión del mismo usuario se cierra con 4029', async () => {
    const user = await registerUser(h.app);
    const open = await Promise.all([connect(user), connect(user), connect(user)]);
    const fourth = await connect(user);
    expect((await fourth.closed).code).toBe(4029);
    await Promise.all(open.map((s) => s.close()));
  });
});

describe('varias réplicas y reconexión', () => {
  it('jugadores en réplicas distintas reciben los mismos eventos (vía Redis)', async () => {
    const other = await h.addReplica();
    const { matchId, ana, beto } = await startMatch();
    const sa = await connect(ana, h.baseUrl);
    const sb = await connect(beto, other.baseUrl);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);

    for (let i = 0; i < 4; i++) {
      const turn = await turnOf(matchId);
      const socket = turn.playerId === ana.id ? sa : sb;
      const id = randomUUID();
      socket.send(play(matchId, turn.cardId, turn.seq, id));
      await socket.next(isAck(id));
    }
    const finalSeq = (await turnOf(matchId)).seq;
    const [ea, eb] = await Promise.all([sa.eventsUpTo(finalSeq), sb.eventsUpTo(finalSeq)]);
    expect(ea.map((e) => e.seq)).toEqual(eb.map((e) => e.seq));
    await Promise.all([sa.close(), sb.close()]);
  });

  it('al reconectar recupera el estado actual, aunque la partida haya avanzado', async () => {
    const { matchId, ana, beto } = await startMatch();
    const sa = await connect(ana);
    let sb = await connect(beto);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    await sb.close();

    for (let i = 0; i < 3; i++) {
      const turn = await turnOf(matchId);
      await h.services.store.apply(matchId, { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId });
    }
    const current = (await turnOf(matchId)).seq;
    sb = await connect(beto);
    expect(((await sb.next(isSnapshot)) as Snapshot).seq).toBe(current);
    await Promise.all([sa.close(), sb.close()]);
  });

  it('una réplica que se apaga cierra con 1012 y rechaza conexiones nuevas con 503', async () => {
    const other = await h.addReplica();
    const user = await registerUser(h.app);
    const socket = await connect(user, other.baseUrl);
    other.draining.value = true;
    expect(await handshakeStatus(other.baseUrl, `?ticket=${await ticketFor(h.app, user)}`)).toBe(503);
    await other.realtime?.close();
    expect((await socket.closed).code).toBe(1012);
  });
});

describe('reloj del servidor', () => {
  it('turno vencido: el servidor juega la carta por defecto y todos lo ven', async () => {
    const { matchId, ana, beto } = await startMatch();
    const [sa, sb] = await Promise.all([connect(ana), connect(beto)]);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    const before = await turnOf(matchId);

    h.clock.advance(30_001);
    const result = await h.services.sweeper.tick();
    expect(result.turnTimeouts).toBe(1);
    // Un segundo barrido (u otra réplica) no lo vuelve a aplicar.
    expect((await h.services.sweeper.tick()).turnTimeouts).toBe(0);

    for (const socket of [sa, sb]) {
      const played = await socket.next((m) => m.type === 'event' && m.event.type === 'CardPlayed');
      expect(played).toMatchObject({ event: { playerId: before.playerId, auto: true } });
    }
    await Promise.all([sa.close(), sb.close()]);
  });

  it('desconexión más allá del periodo de gracia: abandono y el otro gana', async () => {
    const { matchId, ana, beto } = await startMatch();
    const sa = await connect(ana);
    const sb = await connect(beto);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    await sb.close();
    await new Promise((r) => setTimeout(r, 100));

    h.clock.advance(59_000);
    expect((await h.services.sweeper.tick()).abandons).toBe(0);
    h.clock.advance(2_000);
    await h.services.sweeper.tick();

    const ended = await sa.next((m) => m.type === 'event' && m.event.type === 'MatchEnded');
    expect(ended).toMatchObject({ event: { result: { kind: 'winner', winner: ana.id } } });
    const { rows } = await h.db.query<{ status: string }>('SELECT status FROM matches WHERE id = $1', [matchId]);
    expect(rows[0]?.status).toBe('finished');
    await sa.close();
  });

  it('quien nunca se conecta también cae en la regla de abandono', async () => {
    const { ana } = await startMatch();
    const sa = await connect(ana);
    await sa.next(isSnapshot);
    h.clock.advance(61_000);
    await h.services.sweeper.tick();
    expect(await sa.next((m) => m.type === 'event' && m.event.type === 'MatchEnded')).toMatchObject({
      event: { result: { winner: ana.id } },
    });
    await sa.close();
  });

  it('salir de la partida por WebSocket la termina para el otro', async () => {
    const { matchId, ana, beto } = await startMatch();
    const [sa, sb] = await Promise.all([connect(ana), connect(beto)]);
    await Promise.all([sa.next(isSnapshot), sb.next(isSnapshot)]);
    const id = randomUUID();
    sb.send({ v: 1, type: 'leave_match', id, matchId });
    await sb.next(isAck(id));
    expect(await sa.next((m) => m.type === 'event' && m.event.type === 'MatchEnded')).toMatchObject({
      event: { result: { winner: ana.id } },
    });
    await Promise.all([sa.close(), sb.close()]);
  });
});
