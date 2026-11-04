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
import {
  cardHelp,
  cardName,
  describeEvent,
  isPlayable,
  RejectedError,
  validTargets,
  type ReconnectingSession,
} from '@arenal/client';
import { needsTarget, type PlayerView } from '@arenal/domain';
import { arg, connectResilient, createPlayer, type Player } from './players.js';

const url = arg('url', 'http://localhost:8080');
const rl = createInterface({ input: process.stdin, output: process.stdout });

function showTable(view: PlayerView, who: (id: string) => string): void {
  const players = view.players
    .map(
      (p) =>
        `${who(p.id)}: ${p.eliminated ? 'fuera' : `${'♥'.repeat(p.lives)}${p.shielded ? ' [escudo]' : ''} ${p.handCount} cartas`}`,
    )
    .join(' | ');
  console.log(`\nRonda ${view.round} · presión ${view.pressure} · límite anterior ${view.lastRevealedLimit ?? '—'}`);
  console.log(players);
  const peek = view.you?.peek;
  if (peek !== null && peek !== undefined)
    console.log(`Viste con Ceniza: ${cardName(peek.card)} de ${who(peek.targetId)}`);
  const hand = view.you?.hand ?? [];
  for (const [i, c] of hand.entries()) console.log(`  [${i + 1}] ${cardName(c)}: ${cardHelp(c, view.rules)}`);
  if (view.playsLeft === 2) console.log('Desvío: juegas dos cartas en este turno.');
}

/** Pregunta contra quién se juega la carta; si hay un solo rival posible, no pregunta. */
async function askTarget(view: PlayerView, who: (id: string) => string): Promise<string | undefined> {
  const targets = validTargets(view);
  if (targets.length <= 1) return targets[0];
  const options = targets.map((id, i) => `[${i + 1}] ${who(id)}`).join('  ');
  const answer = Number((await rl.question(`¿Contra quién? ${options}: `)).trim());
  return targets[answer - 1];
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
    console.log('En la cola; la partida empieza sola cuando haya jugadores (prueba `pnpm bot --bots 2`).');
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
      const current = socket.view;
      if (card === undefined || current === null) continue;
      if (!isPlayable(current, card)) {
        console.log('Esa carta no se puede jugar ahora (ya tienes escudo o no hay a quién apuntar).');
        continue;
      }
      const targetId = needsTarget(card) ? await askTarget(current, who) : undefined;
      if (needsTarget(card) && targetId === undefined) continue;
      try {
        await socket.playCard(card.id, targetId);
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

try {
  conn.link = await connectResilient(
    player,
    {
      onSnapshot: (view) => {
        if (view.currentPlayer !== player.id) showTable(view, who);
        scheduleAsk();
      },
      onEvent: (event, _seq, view) => {
        const line = describeEvent(event, player.id, who);
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
} catch (error) {
  console.error(`No se pudo conectar a ${url}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(`Conectado a ${url} como ${player.name}.`);
await lobby(player);
