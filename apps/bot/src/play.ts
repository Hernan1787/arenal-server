/**
 * Cliente de prueba en la terminal: para jugar a mano contra los bots o contra otra persona.
 *
 *   pnpm play --url http://localhost:8080 --name Hernán
 *
 * Crea un usuario temporal, y deja elegir entre la cola rápida, crear una sala privada o unirse
 * con un código. Durante la partida muestra la mesa y pide la carta cuando es tu turno. Si la
 * réplica se apaga (por ejemplo al publicar una revisión nueva), reconecta sola y sigue jugando.
 */
import { createInterface } from 'node:readline/promises';
import { RejectedError, type ReconnectingSession } from '@arenal/client';
import type { Card, PlayerEvent, PlayerView } from '@arenal/domain';
import { arg, connectResilient, createPlayer, type Player } from './players.js';

const url = arg('url', 'http://localhost:8080');
const rl = createInterface({ input: process.stdin, output: process.stdout });

const cardName = (card: Card): string =>
  card.kind === 'stone' ? `Piedra ${card.value}` : card.kind === 'cool' ? 'Enfriar' : 'Sismógrafo';

function describe(event: PlayerEvent, me: string, who: (id: string) => string): string | null {
  switch (event.type) {
    case 'MatchStarted':
      return `Empieza la partida. Orden: ${event.playerOrder.map(who).join(', ')}`;
    case 'RoundStarted':
      return `— Ronda ${event.round}: el volcán tiene un límite nuevo (secreto) —`;
    case 'CardPlayed':
      return `${who(event.playerId)} juega ${cardName(event.card)}${event.auto ? ' (se le venció el turno)' : ''}. Presión: ${event.pressureAfter}`;
    case 'SeismoRead':
      return event.playerId === me && event.near !== undefined
        ? `Tu sismógrafo dice: ${event.near ? 'CERCA del límite' : 'lejos del límite'}`
        : `${who(event.playerId)} consultó el sismógrafo`;
    case 'Eruption':
      return `¡Erupción! El límite era ${event.limit}. ${who(event.playerId)} queda con ${event.livesLeft} vida(s)`;
    case 'PlayerEliminated':
      return `${who(event.playerId)} queda eliminado (${event.reason === 'abandon' ? 'abandono' : 'sin vidas'})`;
    case 'MatchEnded': {
      const r = event.result;
      if (r.kind === 'winner') return `Fin de la partida. Gana ${who(r.winner)}`;
      if (r.kind === 'draw') return `Fin de la partida. Empate entre ${r.players.map(who).join(', ')}`;
      return 'Un administrador terminó la partida';
    }
    case 'DeckShuffled':
    case 'DiscardReshuffled':
    case 'CardDrawn':
    case 'TurnStarted':
      return null;
  }
}

function showTable(view: PlayerView, who: (id: string) => string): void {
  const players = view.players
    .map((p) => `${who(p.id)}: ${p.eliminated ? 'fuera' : `${'♥'.repeat(p.lives)} ${p.handCount} cartas`}`)
    .join(' | ');
  console.log(`\nRonda ${view.round} · presión ${view.pressure} · límite anterior ${view.lastRevealedLimit ?? '—'}`);
  console.log(players);
  const hand = view.you?.hand ?? [];
  console.log(`Tu mano: ${hand.map((c, i) => `[${i + 1}] ${cardName(c)}`).join('  ')}`);
}

async function lobby(player: Player): Promise<void> {
  const choice = (await rl.question('\n[1] Cola rápida  [2] Crear sala privada  [3] Unirme con código: ')).trim();
  if (choice === '2') {
    const room = await player.api.createRoom({ visibility: 'private', capacity: 4 });
    console.log(`Sala creada. Código para invitar: ${room.inviteCode ?? '?'}`);
    await rl.question('Cuando estén todos, Enter para marcar «listo»... ');
    await player.api.setReady(room.id, true);
  } else if (choice === '3') {
    const code = (await rl.question('Código: ')).trim().toUpperCase();
    const room = await player.api.joinByCode(code);
    await rl.question('Enter para marcar «listo»... ');
    await player.api.setReady(room.id, true);
  } else {
    await player.api.enqueue();
    console.log('En la cola; la partida empieza sola cuando haya jugadores (prueba `pnpm bot --bots 3`).');
  }
}

const givenName = arg('name', '');
const player = await createPlayer(url, givenName || (await rl.question('Tu nombre: ')).trim() || 'Jugador');
const who = (id: string): string => (id === player.id ? 'Tú' : `Jugador ${id.slice(0, 4)}`);
const conn: { link?: ReconnectingSession } = {};
let asking = false;

let pendingAsk: NodeJS.Timeout | undefined;

/** Una jugada trae varios eventos seguidos: se espera a que lleguen todos antes de preguntar. */
function scheduleAsk(): void {
  clearTimeout(pendingAsk);
  pendingAsk = setTimeout(() => {
    const view = conn.link?.current.view ?? null;
    if (view !== null) void askCard(view);
  }, 80);
}

async function askCard(view: PlayerView): Promise<void> {
  if (asking || view.currentPlayer !== player.id || view.status !== 'playing') return;
  asking = true;
  try {
    showTable(view, who);
    for (;;) {
      // La conexión puede cambiar mientras se espera la respuesta (reconexión): se toma la vigente.
      const socket = conn.link?.current;
      if (socket === undefined) return;
      const hand = socket.view?.you?.hand ?? [];
      const answer = Number((await rl.question('Es tu turno. Carta: ')).trim());
      const card = hand[answer - 1];
      if (card === undefined) continue;
      try {
        await socket.playCard(card.id);
        return;
      } catch (error) {
        console.log(error instanceof RejectedError ? `No se pudo: ${error.message}` : String(error));
        if (socket.view?.currentPlayer !== player.id) return;
      }
    }
  } finally {
    asking = false;
  }
}

conn.link = await connectResilient(
  player,
  {
    onSnapshot: (view) => {
      if (view.currentPlayer !== player.id) showTable(view, who);
      scheduleAsk();
    },
    onEvent: (event, _seq, view) => {
      const line = describe(event, player.id, who);
      if (line !== null) console.log(line);
      if (event.type === 'MatchEnded') {
        void lobby(player);
        return;
      }
      if (view.status === 'playing') scheduleAsk();
    },
    onClose: (code, reason) => {
      console.log(`Conexión cerrada (${code}${reason ? `: ${reason}` : ''}).`);
      process.exit(0);
    },
  },
  {
    onDisconnect: (code, reason) => {
      console.log(`\n[conexión] Se cerró (${code}${reason ? `: ${reason}` : ''}). Reconectando…`);
    },
    onReconnect: (attempts) => {
      console.log(`[conexión] Reconectado (${attempts} intento${attempts === 1 ? '' : 's'}). La partida sigue.`);
    },
  },
);
console.log(`Conectado a ${url} como ${player.name}.`);
await lobby(player);
