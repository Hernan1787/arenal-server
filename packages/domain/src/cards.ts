import type { ArenalConfig } from './config.js';
import { shuffle, type Rng } from './rng.js';
import { findPlayer, nextAlivePlayer, type GameState } from './state.js';
import { DomainInvariantError, needsTarget, type Card, type CardId, type PlayerId, type StoneValue } from './types.js';

const ID_ALPHABET_SIZE = 36;
const ID_LENGTH = 6;
const MAX_ID = ID_ALPHABET_SIZE ** ID_LENGTH - 1;
const MAX_ID_ATTEMPTS = 100;

const SPECIAL_KINDS = ['bomb', 'quake', 'cool', 'rain', 'seismo', 'divert', 'ash', 'steal', 'shield'] as const;

function randomCardId(rng: Rng): CardId {
  return `c_${rng.int(0, MAX_ID).toString(ID_ALPHABET_SIZE).padStart(ID_LENGTH, '0')}`;
}

/** Crea el mazo completo con IDs opacos y únicos, ya barajado. */
export function buildShuffledDeck(config: ArenalConfig, rng: Rng): Card[] {
  const used = new Set<CardId>();
  const nextId = (): CardId => {
    // Con un generador sano un choque es rarísimo (62 IDs entre 2 mil millones); si se repite
    // tanto, el generador está roto y es mejor fallar que quedarse en un ciclo infinito.
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = randomCardId(rng);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new DomainInvariantError('El generador de azar repite los IDs de carta');
  };

  const cards: Card[] = [];
  const stoneValues: readonly StoneValue[] = [1, 2, 3, 4];
  for (const value of stoneValues) {
    for (let i = 0; i < config.deck.stones[value]; i++) cards.push({ id: nextId(), kind: 'stone', value });
  }
  for (const kind of SPECIAL_KINDS) {
    for (let i = 0; i < config.deck[kind]; i++) cards.push({ id: nextId(), kind });
  }

  return shuffle(cards, rng);
}

/**
 * Orden en que el servidor elige carta cuando vence el turno: primero la piedra de menor valor y
 * las que no ayudan mucho; las que dan ventaja (ver o quitar cartas) van al final. Así dejar
 * vencer el turno nunca es mejor que jugar.
 */
const DEFAULT_ORDER: readonly Card['kind'][] = [
  'stone',
  'quake',
  'seismo',
  'cool',
  'rain',
  'divert',
  'shield',
  'bomb',
  'ash',
  'steal',
];

export interface Play {
  readonly cardId: CardId;
  readonly targetId?: PlayerId;
}

/** A quién apunta el servidor cuando juega Ceniza o Robo por alguien: el siguiente que tenga cartas. */
export function defaultTarget(state: GameState, playerId: PlayerId): PlayerId | undefined {
  let candidate = nextAlivePlayer(state, playerId);
  for (let step = 0; step < state.players.length && candidate !== null && candidate !== playerId; step++) {
    if ((findPlayer(state, candidate)?.hand.length ?? 0) > 0) return candidate;
    candidate = nextAlivePlayer(state, candidate);
  }
  return undefined;
}

/** La jugada que hace el servidor cuando vence el turno, o `undefined` si no hay ninguna válida. */
export function defaultPlay(state: GameState, playerId: PlayerId): Play | undefined {
  const player = findPlayer(state, playerId);
  if (player === undefined) return undefined;
  const target = defaultTarget(state, playerId);
  const legal = player.hand.filter(
    (c) => !(c.kind === 'shield' && player.shielded) && !(needsTarget(c) && target === undefined),
  );
  const rank = (c: Card): number => DEFAULT_ORDER.indexOf(c.kind) * 10 + (c.kind === 'stone' ? c.value : 0);
  const [card] = [...legal].sort((a, b) => rank(a) - rank(b));
  if (card === undefined) return undefined;
  return needsTarget(card) && target !== undefined ? { cardId: card.id, targetId: target } : { cardId: card.id };
}
