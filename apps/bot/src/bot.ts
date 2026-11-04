/**
 * Bots que juegan solos por la cola de emparejamiento.
 *
 *   pnpm bot --url http://localhost:8080 --bots 3 --games 3 --think 2000
 *
 * Cada bot se registra, abre su WebSocket, entra a la cola y juega con una estrategia simple
 * (ver @arenal/client). Antes de cada jugada «piensa» `--think` milisegundos, más o menos la mitad
 * al azar, para que se pueda seguir la partida. Al terminar una partida vuelve a la cola hasta jugar `--games`. Si su
 * réplica se apaga, reconecta y sigue la misma partida.
 */
import { choosePlay, isMyTurn, RejectedError, type ReconnectingSession } from '@arenal/client';
import type { PlayerView } from '@arenal/domain';
import { arg, connectResilient, createPlayers, sleep, type Player } from './players.js';

const url = arg('url', 'http://localhost:8080');
const bots = Number(arg('bots', '3'));
const games = Number(arg('games', '1'));
const thinkMs = Number(arg('think', '2000'));
/** Entre la mitad y una vez y media de `--think`: así no juegan todos al mismo ritmo. */
const thinkTime = (): number => thinkMs * (0.5 + Math.random());

interface Stats {
  played: number;
  moves: number;
  wins: number;
}

async function runBot(player: Player): Promise<Stats> {
  const stats: Stats = { played: 0, moves: 0, wins: 0 };
  let timer: NodeJS.Timeout | undefined;
  const conn: { link?: ReconnectingSession } = {};
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
      const socket = conn.link?.current;
      const current = socket?.view ?? null;
      const play = isMyTurn(current) ? choosePlay(current) : undefined;
      if (socket === undefined || play === undefined) return;
      socket.playCard(play.card.id, play.targetId).then(
        () => {
          stats.moves += 1;
        },
        (error: unknown) => {
          // STALE_STATE: llegó un evento mientras pensaba; se vuelve a considerar con el nuevo.
          // RATE_LIMITED: se reintenta un poco después.
          if (error instanceof RejectedError && error.code === 'RATE_LIMITED') {
            setTimeout(() => {
              if (socket.view !== null) consider(socket.view);
            }, 500);
          } else if (!(error instanceof RejectedError && error.retryable)) {
            console.error(`${player.name}:`, String(error));
          }
        },
      );
    }, thinkTime());
  };

  const link = await connectResilient(
    player,
    {
      onSnapshot: consider,
      onEvent: (_event, _seq, view) => {
        consider(view);
      },
    },
    {
      onDisconnect: (code) => {
        console.log(`${player.name}: se cerró la conexión (${code}); reconectando`);
      },
      onReconnect: () => {
        console.log(`${player.name}: reconectado`);
      },
      onGiveUp: (code) => {
        if (code !== 1000) console.error(`${player.name}: sin conexión (${code})`);
        finish();
      },
    },
  );
  conn.link = link;
  await player.api.enqueue();
  await done;
  link.close();
  return stats;
}

const players = await createPlayers(url, bots, 'Bot');
console.log(`${bots} bots registrados en ${url}; cada uno juega ${games} partida(s).`);
const results = await Promise.all(players.map((p) => runBot(p)));
await sleep(100);
for (const [i, r] of results.entries()) {
  console.log(`${players[i]?.name ?? '?'}: ${r.played} partidas, ${r.moves} jugadas, ${r.wins} ganadas`);
}
