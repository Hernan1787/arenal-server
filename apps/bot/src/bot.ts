/**
 * Bots que juegan solos por la cola de emparejamiento.
 *
 *   pnpm bot --url http://localhost:8080 --bots 4 --games 3 --think 300
 *
 * Cada bot se registra, abre su WebSocket, entra a la cola y juega con una estrategia simple
 * (ver @arenal/client). Al terminar una partida vuelve a la cola hasta jugar `--games`.
 */
import { chooseCard, isMyTurn, RejectedError, type RealtimeSession } from '@arenal/client';
import type { PlayerView } from '@arenal/domain';
import { arg, connect, createPlayers, sleep, type Player } from './players.js';

const url = arg('url', 'http://localhost:8080');
const bots = Number(arg('bots', '4'));
const games = Number(arg('games', '1'));
const thinkMs = Number(arg('think', '300'));

interface Stats {
  played: number;
  moves: number;
  wins: number;
}

async function runBot(player: Player): Promise<Stats> {
  const stats: Stats = { played: 0, moves: 0, wins: 0 };
  let timer: NodeJS.Timeout | undefined;
  const conn: { socket?: RealtimeSession } = {};
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const consider = (view: PlayerView): void => {
    clearTimeout(timer);
    if (view.status === 'finished') {
      stats.played += 1;
      if (view.result?.kind === 'winner' && view.result.winner === player.id) stats.wins += 1;
      if (stats.played >= games) finish();
      else {
        player.api.enqueue().catch((error: unknown) => {
          console.error(`${player.name}:`, String(error));
        });
      }
      return;
    }
    if (!isMyTurn(view)) return;
    // Espera un poco (como una persona) y juega sobre la versión que tenga en ese momento.
    timer = setTimeout(() => {
      const socket = conn.socket;
      const current = socket?.view ?? null;
      const card = isMyTurn(current) ? chooseCard(current) : undefined;
      if (socket === undefined || card === undefined) return;
      socket.playCard(card.id).then(
        () => {
          stats.moves += 1;
        },
        (error: unknown) => {
          // STALE_STATE: llegó un evento mientras pensaba; se vuelve a considerar con el nuevo.
          if (!(error instanceof RejectedError && error.retryable)) console.error(`${player.name}:`, String(error));
        },
      );
    }, thinkMs);
  };

  const socket = await connect(player, {
    onSnapshot: consider,
    onEvent: (_event, _seq, view) => {
      consider(view);
    },
  });
  conn.socket = socket;
  await player.api.enqueue();
  await done;
  socket.close();
  return stats;
}

const players = await createPlayers(url, bots, 'Bot');
console.log(`${bots} bots registrados en ${url}; cada uno juega ${games} partida(s).`);
const results = await Promise.all(players.map((p) => runBot(p)));
await sleep(100);
for (const [i, r] of results.entries()) {
  console.log(`${players[i]?.name ?? '?'}: ${r.played} partidas, ${r.moves} jugadas, ${r.wins} ganadas`);
}
