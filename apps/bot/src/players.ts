import { randomUUID } from 'node:crypto';
import { ArenalApi, RealtimeSession, type RealtimeHandlers } from '@arenal/client';

export interface Player {
  readonly api: ArenalApi;
  readonly id: string;
  readonly name: string;
}

/** Registra un usuario nuevo con correo y contraseña aleatorios (no queda nada escrito). */
export async function createPlayer(baseUrl: string, name: string): Promise<Player> {
  const api = new ArenalApi(baseUrl);
  const session = await api.register({
    email: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${randomUUID().slice(0, 8)}@bots.arenal.invalid`,
    password: `b-${randomUUID()}`,
    displayName: name,
  });
  return { api, id: session.user.id, name };
}

/** Registra `count` usuarios, de a `concurrency` a la vez. */
export async function createPlayers(
  baseUrl: string,
  count: number,
  prefix: string,
  concurrency = 10,
): Promise<Player[]> {
  const players: Player[] = new Array<Player>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next < count) {
        const index = next++;
        players[index] = await createPlayer(baseUrl, `${prefix} ${index + 1}`);
      }
    }),
  );
  return players;
}

export async function connect(player: Player, handlers: RealtimeHandlers = {}): Promise<RealtimeSession> {
  return RealtimeSession.open(player.api.baseUrl, await player.api.realtimeTicket(), handlers);
}

/** Arma una partida por sala: el primero la crea, los demás se unen y todos marcan «listo». */
export async function startRoomMatch(players: readonly Player[]): Promise<string> {
  const [host, ...guests] = players;
  if (host === undefined || guests.length === 0) throw new Error('Una partida necesita al menos 2 jugadores');
  const room = await host.api.createRoom({ visibility: 'public', capacity: players.length });
  for (const guest of guests) await guest.api.joinRoom(room.id);
  let matchId: string | null = null;
  for (const player of players) matchId = (await player.api.setReady(room.id, true)).matchId ?? matchId;
  if (matchId === null) throw new Error('La sala no arrancó');
  return matchId;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lee `--nombre valor` de la línea de comandos. */
export function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}
