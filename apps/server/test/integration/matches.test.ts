import { randomUUID } from 'node:crypto';
import { PlayerViewSchema } from '@arenal/contracts';
import { describe, expect, it } from 'vitest';
import { MatchStore } from '../../src/matches/match-store.js';
import { cryptoRng } from '../../src/rng.js';
import { expectProblem, registerUsers, useHarness, type TestUser } from './harness.js';

const h = useHarness();

/** Arma una partida de 2 por sala y devuelve su ID con los dos jugadores. */
async function startMatch(): Promise<{ matchId: string; players: TestUser[] }> {
  const players = await registerUsers(h.app, 2);
  const [ana, beto] = players;
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
  return { matchId: started.matchId, players };
}

async function currentTurn(matchId: string): Promise<{ playerId: string; cardId: string; seq: number }> {
  const loaded = await h.services.store.load(matchId);
  if (loaded === undefined) throw new Error('no existe la partida');
  const playerId = loaded.state.currentPlayer;
  const card = loaded.state.players.find((p) => p.id === playerId)?.hand[0];
  if (playerId === null || card === undefined) throw new Error('sin turno');
  return { playerId, cardId: card.id, seq: loaded.row.seq };
}

describe('jugadas: orden, idempotencia y rechazo', () => {
  it('una jugada válida guarda sus eventos con secuencia consecutiva', async () => {
    const { matchId } = await startMatch();
    const turn = await currentTurn(matchId);
    const result = await h.services.store.apply(
      matchId,
      { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId },
      {
        moveId: randomUUID(),
        actorId: turn.playerId,
        expectedSeq: turn.seq,
      },
    );
    if (result.kind !== 'applied') throw new Error(JSON.stringify(result));
    expect(result.events.map((e) => e.seq)).toEqual(result.events.map((_, i) => turn.seq + i + 1));

    const { rows } = await h.db.query<{ seq: number }>(
      'SELECT seq FROM match_events WHERE match_id = $1 ORDER BY seq',
      [matchId],
    );
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: result.seq }, (_, i) => i + 1));
  });

  it('reenviar la misma jugada (mismo moveId) no la aplica dos veces', async () => {
    const { matchId } = await startMatch();
    const turn = await currentTurn(matchId);
    const moveId = randomUUID();
    const intent = { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId } as const;
    const options = { moveId, actorId: turn.playerId, expectedSeq: turn.seq };

    const first = await h.services.store.apply(matchId, intent, options);
    const again = await h.services.store.apply(matchId, intent, options);
    expect(first.kind).toBe('applied');
    expect(again).toEqual({ kind: 'duplicate', seq: first.kind === 'applied' ? first.seq : -1 });

    const { rows } = await h.db.query<{ n: string }>('SELECT count(*) AS n FROM match_moves WHERE match_id = $1', [
      matchId,
    ]);
    expect(rows[0]?.n).toBe('1');
  });

  it('una jugada sobre una versión vieja se rechaza con STALE_STATE', async () => {
    const { matchId } = await startMatch();
    const turn = await currentTurn(matchId);
    const result = await h.services.store.apply(
      matchId,
      { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId },
      {
        moveId: randomUUID(),
        actorId: turn.playerId,
        expectedSeq: turn.seq - 1,
      },
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'STALE_STATE', seq: turn.seq });
  });

  it('jugar fuera de turno se rechaza con un error tipado y no cambia nada', async () => {
    const { matchId, players } = await startMatch();
    const turn = await currentTurn(matchId);
    const other = players.find((p) => p.id !== turn.playerId);
    if (other === undefined) throw new Error('falta el otro jugador');
    const result = await h.services.store.apply(matchId, {
      type: 'play_card',
      playerId: other.id,
      cardId: turn.cardId,
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'NOT_YOUR_TURN' });
    expect((await currentTurn(matchId)).seq).toBe(turn.seq);
  });

  it('dos jugadas simultáneas sobre la misma versión: una se aplica y la otra queda STALE_STATE', async () => {
    const { matchId } = await startMatch();
    const turn = await currentTurn(matchId);
    const loaded = await h.services.store.load(matchId);
    const hand = loaded?.state.players.find((p) => p.id === turn.playerId)?.hand ?? [];
    const [a, b] = hand;
    if (a === undefined || b === undefined) throw new Error('mano incompleta');

    const results = await Promise.all(
      [a, b].map((card) =>
        h.services.store.apply(
          matchId,
          { type: 'play_card', playerId: turn.playerId, cardId: card.id },
          {
            moveId: randomUUID(),
            actorId: turn.playerId,
            expectedSeq: turn.seq,
          },
        ),
      ),
    );
    expect(results.map((r) => (r.kind === 'rejected' ? r.code : r.kind)).sort()).toEqual(['STALE_STATE', 'applied']);
  });

  it('50 jugadas concurrentes sin expectedSeq: la secuencia queda sin huecos ni repetidos', async () => {
    const { matchId } = await startMatch();
    // Cada intento juega la primera carta de quien tenga el turno en ese momento; muchos
    // fallan (la carta ya no está o cambió el turno), pero ninguno puede romper el orden.
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const turn = await currentTurn(matchId).catch(() => null);
        if (turn === null) return;
        await h.services.store.apply(matchId, { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId });
      }),
    );
    const { rows } = await h.db.query<{ seq: number }>(
      'SELECT seq FROM match_events WHERE match_id = $1 ORDER BY seq',
      [matchId],
    );
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    const loaded = await h.services.store.load(matchId);
    expect(loaded?.row.seq).toBe(rows.length);
  });
});

describe('durabilidad y fin de partida', () => {
  it('otra instancia (como una réplica nueva) reconstruye exactamente el mismo estado', async () => {
    const { matchId } = await startMatch();
    for (let i = 0; i < 5; i++) {
      const turn = await currentTurn(matchId);
      await h.services.store.apply(matchId, { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId });
    }
    const fresh = new MatchStore({ db: h.db, clock: h.clock, rng: cryptoRng, turnTimeoutMs: 30_000 });
    expect((await fresh.load(matchId))?.state).toEqual((await h.services.store.load(matchId))?.state);
  });

  it('una partida jugada hasta el final: resultado guardado, jugadores liberados, historial y repetición', async () => {
    const { matchId, players } = await startMatch();
    let guard = 0;
    for (;;) {
      const loaded = await h.services.store.load(matchId);
      if (loaded?.state.status !== 'playing') break;
      const turn = await currentTurn(matchId);
      await h.services.store.apply(matchId, { type: 'play_card', playerId: turn.playerId, cardId: turn.cardId });
      if (++guard > 2000) throw new Error('la partida no termina');
    }

    const { rows } = await h.db.query<{
      status: string;
      result: unknown;
      finished_at: Date | null;
      turn_deadline: Date | null;
    }>('SELECT status, result, finished_at, turn_deadline FROM matches WHERE id = $1', [matchId]);
    expect(rows[0]).toMatchObject({ status: 'finished', turn_deadline: null });
    expect(rows[0]?.result).not.toBeNull();
    expect(rows[0]?.finished_at).not.toBeNull();
    const active = await h.db.query('SELECT 1 FROM match_players WHERE match_id = $1 AND active', [matchId]);
    expect(active.rowCount).toBe(0);

    const [ana] = players;
    if (ana === undefined) throw new Error('falta usuario');
    const history = await h.app.inject({ method: 'GET', url: '/v1/me/matches', headers: ana.auth });
    expect(history.json<{ items: { matchId: string; status: string }[] }>().items).toEqual([
      expect.objectContaining({ matchId, status: 'finished' }),
    ]);

    const replay = await h.app.inject({ method: 'GET', url: `/v1/matches/${matchId}/replay`, headers: ana.auth });
    expect(replay.statusCode).toBe(200);
    const events = replay.json<{
      events: { seq: number; event: { type: string; card?: { id: string }; playerId?: string } }[];
    }>().events;
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    // En la repetición, las cartas que robó el otro siguen ocultas.
    for (const e of events) {
      if (e.event.type === 'CardDrawn' && e.event.playerId !== ana.id) expect(e.event.card).toBeUndefined();
      if (e.event.type === 'DeckShuffled') expect(e.event).not.toHaveProperty('cards');
    }

    // Ya libres: pueden volver a la cola.
    expect((await h.app.inject({ method: 'POST', url: '/v1/matchmaking/ticket', headers: ana.auth })).statusCode).toBe(
      202,
    );
  });
});

describe('vistas por jugador', () => {
  it('el estado de la partida solo muestra la mano propia y nunca el límite', async () => {
    const { matchId, players } = await startMatch();
    const [ana, beto] = players;
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    const res = await h.app.inject({ method: 'GET', url: `/v1/matches/${matchId}`, headers: ana.auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ seq: number; view: unknown }>();
    const view = PlayerViewSchema.parse(body.view);
    expect(view.you?.id).toBe(ana.id);

    const loaded = await h.services.store.load(matchId);
    const betoCards = loaded?.state.players.find((p) => p.id === beto.id)?.hand.map((c) => c.id) ?? [];
    expect(betoCards.length).toBeGreaterThan(0);
    for (const id of betoCards) expect(res.body).not.toContain(id);
    expect(res.body).not.toMatch(/"limit"/);
  });

  it('quien no participa recibe 404, también en la repetición', async () => {
    const { matchId } = await startMatch();
    const [intruso] = await registerUsers(h.app, 1);
    if (intruso === undefined) throw new Error('falta usuario');
    expectProblem(await h.app.inject({ method: 'GET', url: `/v1/matches/${matchId}`, headers: intruso.auth }), 404);
    expectProblem(
      await h.app.inject({ method: 'GET', url: `/v1/matches/${matchId}/replay`, headers: intruso.auth }),
      404,
    );
  });

  it('la repetición de una partida en curso no se entrega', async () => {
    const { matchId, players } = await startMatch();
    const [ana] = players;
    if (ana === undefined) throw new Error('falta usuario');
    expectProblem(
      await h.app.inject({ method: 'GET', url: `/v1/matches/${matchId}/replay`, headers: ana.auth }),
      409,
      'MATCH_IN_PROGRESS',
    );
  });
});
