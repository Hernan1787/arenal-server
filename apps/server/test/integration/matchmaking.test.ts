import { describe, expect, it } from 'vitest';
import { expectProblem, registerUsers, useHarness, type TestUser } from './harness.js';

const h = useHarness();

type Status = { state: 'idle' } | { state: 'waiting'; waitedMs: number } | { state: 'matched'; matchId: string } | { state: 'expired' };

const enqueue = (u: TestUser) => h.app.inject({ method: 'POST', url: '/v1/matchmaking/ticket', headers: u.auth });
const status = async (u: TestUser): Promise<Status> =>
  (await h.app.inject({ method: 'GET', url: '/v1/matchmaking/ticket', headers: u.auth })).json<Status>();

describe('cola de emparejamiento', () => {
  it('con 4 en la cola arma una partida y todos quedan asignados a la misma', async () => {
    const users = await registerUsers(h.app, 4);
    for (const u of users.slice(0, 3)) expect((await enqueue(u)).json<Status>().state).toBe('waiting');
    const last = users[3];
    if (last === undefined) throw new Error('falta usuario');
    expect((await enqueue(last)).json<Status>().state).toBe('matched');

    const statuses = await Promise.all(users.map(status));
    const matchIds = new Set(statuses.map((s) => (s.state === 'matched' ? s.matchId : 'ninguna')));
    expect(matchIds.size).toBe(1);
    expect(matchIds.has('ninguna')).toBe(false);
  });

  it('pasado el tiempo de relleno, arma partida con los que haya (mínimo 2)', async () => {
    const [ana, beto] = await registerUsers(h.app, 2);
    if (ana === undefined || beto === undefined) throw new Error('faltan usuarios');
    await enqueue(ana);
    await enqueue(beto);
    expect(await h.services.matchmaking.runMatchmaker()).toEqual([]);

    h.clock.advance(10_000);
    const created = await h.services.matchmaking.runMatchmaker();
    expect(created).toHaveLength(1);
    expect((await status(ana)).state).toBe('matched');
  });

  it('al vencer el tiempo máximo, un ticket solo queda vencido y se puede volver a encolar', async () => {
    const [ana] = await registerUsers(h.app, 1);
    if (ana === undefined) throw new Error('falta usuario');
    await enqueue(ana);
    h.clock.advance(60_000);
    await h.services.matchmaking.runMatchmaker();
    expect(await status(ana)).toEqual({ state: 'expired' });

    expect((await enqueue(ana)).json<Status>().state).toBe('waiting');
  });

  it('salir de la cola deja el ticket en idle', async () => {
    const [ana] = await registerUsers(h.app, 1);
    if (ana === undefined) throw new Error('falta usuario');
    await enqueue(ana);
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/matchmaking/ticket', headers: ana.auth })).statusCode).toBe(204);
    expect(await status(ana)).toEqual({ state: 'idle' });
  });

  it('entrar dos veces a la cola es un conflicto', async () => {
    const [ana] = await registerUsers(h.app, 1);
    if (ana === undefined) throw new Error('falta usuario');
    await enqueue(ana);
    expectProblem(await enqueue(ana), 409, 'ALREADY_QUEUED');
  });

  it('con 10 entrando a la vez y varios barridos en paralelo, nadie queda en dos partidas', async () => {
    const users = await registerUsers(h.app, 10);
    await Promise.all([...users.map(enqueue), h.services.matchmaking.runMatchmaker(), h.services.matchmaking.runMatchmaker()]);
    h.clock.advance(10_000);
    await Promise.all([h.services.matchmaking.runMatchmaker(), h.services.matchmaking.runMatchmaker()]);

    const { rows } = await h.db.query<{ user_id: string; partidas: string }>(
      'SELECT user_id, count(*) AS partidas FROM match_players GROUP BY user_id',
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.partidas === '1')).toBe(true);

    const sizes = await h.db.query<{ n: string }>('SELECT count(*) AS n FROM match_players GROUP BY match_id ORDER BY n DESC');
    // 10 = 4 + 4 + 2: dos llenas y una armada por relleno.
    expect(sizes.rows.map((r) => Number(r.n))).toEqual([4, 4, 2]);
  });

  it('quien ya juega no puede entrar a la cola', async () => {
    const users = await registerUsers(h.app, 4);
    for (const u of users) await enqueue(u);
    const first = users[0];
    if (first === undefined) throw new Error('falta usuario');
    expectProblem(await enqueue(first), 409, 'ALREADY_IN_MATCH');
  });
});
