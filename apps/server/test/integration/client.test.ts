import { ArenalApi, choosePlay, isMyTurn, ReconnectingSession, RealtimeSession, RejectedError } from '@arenal/client';
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
        const move = isMyTurn(current) ? choosePlay(current) : undefined;
        if (move === undefined) return;
        socket.playCard(move.card.id, move.targetId).catch((error: unknown) => {
          // Si el servidor pide bajar el ritmo, se vuelve a intentar; un STALE_STATE se resuelve solo
          // con el evento que viene en camino.
          if (error instanceof RejectedError && error.code === 'RATE_LIMITED' && socket.view !== null) {
            setTimeout(() => {
              if (socket.view !== null) play(socket, socket.view);
            }, 200);
          }
        });
      }, 20);
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

  it('si se corta la conexión a mitad de partida, reconecta, recibe el snapshot y la termina igual', async () => {
    const base = `http://${h.baseUrl}`;
    const apis = [new ArenalApi(base), new ArenalApi(base)];
    const sessions = await Promise.all(
      apis.map((api, i) =>
        api.register({
          email: `reconecta${i}-${Date.now()}@ejemplo.com`,
          password: `p-${crypto.randomUUID()}`,
          displayName: `Reconecta ${i}`,
        }),
      ),
    );

    let finish: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const links: ReconnectingSession[] = [];
    let reconnects = 0;
    let cut = false;
    const play = (link: ReconnectingSession, view: PlayerView): void => {
      if (view.status === 'finished') finish();
      if (!isMyTurn(view)) return;
      setTimeout(() => {
        const socket = link.current;
        const current = socket.view;
        const move = isMyTurn(current) ? choosePlay(current) : undefined;
        if (move === undefined) return;
        // Se reintenta si el servidor pide bajar el ritmo o si la jugada salió por la conexión que se
        // acaba de cortar; un STALE_STATE se resuelve solo con el evento que viene en camino.
        socket.playCard(move.card.id, move.targetId).catch((error: unknown) => {
          if (error instanceof RejectedError && error.code !== 'RATE_LIMITED') return;
          setTimeout(() => {
            const latest = link.current.view;
            if (latest !== null) play(link, latest);
          }, 200);
        });
      }, 20);
    };
    for (const api of apis) {
      const holder: { link?: ReconnectingSession } = {};
      const link = await ReconnectingSession.open(
        api,
        {
          onSnapshot: (view) => {
            if (holder.link !== undefined) play(holder.link, view);
          },
          onEvent: (_event, seq, view) => {
            if (holder.link === undefined) return;
            // A mitad de partida se corta la conexión del primer jugador, como cuando su réplica se apaga.
            if (!cut && seq >= 12 && holder.link === links[0]) {
              cut = true;
              holder.link.current.close(3000);
              return;
            }
            play(holder.link, view);
          },
        },
        {
          initialDelayMs: 50,
          onReconnect: () => {
            reconnects += 1;
          },
        },
      );
      holder.link = link;
      links.push(link);
    }

    const [host, guest] = apis;
    if (host === undefined || guest === undefined) throw new Error('faltan clientes');
    const room = await host.createRoom({ visibility: 'public', capacity: 2 });
    await guest.joinRoom(room.id);
    await host.setReady(room.id, true);
    const started = await guest.setReady(room.id, true);
    await ended;

    expect(cut).toBe(true);
    expect(reconnects).toBe(1);
    const loaded = await h.services.store.load(started.matchId ?? '');
    if (loaded === undefined) throw new Error('no existe la partida');
    expect(loaded.state.status).toBe('finished');
    // Al final, la vista de cada uno (la del que reconectó también) es exactamente la del servidor.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [i, link] of links.entries()) {
      expect(link.current.seq).toBe(loaded.row.seq);
      expect(link.current.view).toEqual(viewFor(loaded.state, sessions[i]?.user.id ?? null));
      link.close();
    }
  });

  it('un ticket inválido falla en el handshake con el código del servidor, sin contar como desconexión', async () => {
    let closed = false;
    await expect(
      RealtimeSession.open(`http://${h.baseUrl}`, 'ticket-que-no-existe', {
        onClose: () => {
          closed = true;
        },
      }),
    ).rejects.toThrow(/401/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
  });
});
