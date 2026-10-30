import { ArenalApi, chooseCard, isMyTurn, RealtimeSession } from '@arenal/client';
import { viewFor, type PlayerView } from '@arenal/domain';
import { describe, expect, it } from 'vitest';
import { useHarness } from './harness.js';

const h = useHarness({ realtime: true });

/**
 * El cliente que usan el bot y la prueba de carga, contra el servidor real: una partida
 * completa por WebSocket. Al final, la vista que el cliente armó aplicando los eventos debe ser
 * idéntica a la que calcula el servidor.
 */
describe('cliente de Arenal contra el servidor', () => {
  it('juega una partida completa y su vista coincide con la del servidor, sin huecos ni mensajes inválidos', async () => {
    const base = `http://${h.baseUrl}`;
    const apis = [new ArenalApi(base), new ArenalApi(base)];
    const sessions = await Promise.all(
      apis.map((api, i) =>
        api.register({
          email: `cliente${i}-${Date.now()}@ejemplo.com`,
          password: `p-${crypto.randomUUID()}`,
          displayName: `Cliente ${i}`,
        }),
      ),
    );

    let finish: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sockets: RealtimeSession[] = [];
    const play = (socket: RealtimeSession, view: PlayerView): void => {
      if (view.status === 'finished') finish();
      if (!isMyTurn(view)) return;
      setTimeout(() => {
        const current = socket.view;
        const card = isMyTurn(current) ? chooseCard(current) : undefined;
        if (card !== undefined) socket.playCard(card.id).catch(() => undefined);
      }, 5);
    };
    for (const api of apis) {
      const socket = await RealtimeSession.open(base, await api.realtimeTicket(), {
        onSnapshot: (view) => {
          play(socket, view);
        },
        onEvent: (_event, _seq, view) => {
          play(socket, view);
        },
      });
      sockets.push(socket);
    }

    const [host, guest] = apis;
    if (host === undefined || guest === undefined) throw new Error('faltan clientes');
    const room = await host.createRoom({ visibility: 'public', capacity: 2 });
    await guest.joinRoom(room.id);
    await host.setReady(room.id, true);
    const started = await guest.setReady(room.id, true);
    await ended;

    const loaded = await h.services.store.load(started.matchId ?? '');
    if (loaded === undefined) throw new Error('no existe la partida');
    for (const [i, socket] of sockets.entries()) {
      expect(socket.gaps).toBe(0);
      expect(socket.invalidMessages).toBe(0);
      expect(socket.seq).toBe(loaded.row.seq);
      expect(socket.view).toEqual(viewFor(loaded.state, sessions[i]?.user.id ?? null));
      socket.close();
    }
    expect(loaded.state.status).toBe('finished');
  });
});
