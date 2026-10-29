import type { ArenalConfig } from './config.js';
import { shuffle, type Rng } from './rng.js';
import type { Card, CardId, StoneValue } from './types.js';

const ID_ALPHABET_SIZE = 36;
const ID_LENGTH = 6;
const MAX_ID = ID_ALPHABET_SIZE ** ID_LENGTH - 1;

function randomCardId(rng: Rng): CardId {
  return `c_${rng.int(0, MAX_ID).toString(ID_ALPHABET_SIZE).padStart(ID_LENGTH, '0')}`;
}

/** Crea el mazo completo con IDs opacos y únicos, ya barajado. */
export function buildShuffledDeck(config: ArenalConfig, rng: Rng): Card[] {
  const used = new Set<CardId>();
  const nextId = (): CardId => {
    for (;;) {
      const id = randomCardId(rng);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  const cards: Card[] = [];
  const stoneValues: readonly StoneValue[] = [1, 2, 3, 4];
  for (const value of stoneValues) {
    for (let i = 0; i < config.deck.stones[value]; i++) cards.push({ id: nextId(), kind: 'stone', value });
  }
  for (let i = 0; i < config.deck.cool; i++) cards.push({ id: nextId(), kind: 'cool' });
  for (let i = 0; i < config.deck.seismo; i++) cards.push({ id: nextId(), kind: 'seismo' });

  return shuffle(cards, rng);
}

/**
 * Carta que juega el servidor cuando vence el turno: la piedra de menor valor;
 * si no hay piedras, el sismógrafo; si tampoco, Enfriar. Así dejar vencer el
 * turno nunca es mejor que jugar.
 */
export function defaultCard(hand: readonly Card[]): Card | undefined {
  const stones = hand.filter((c): c is Extract<Card, { kind: 'stone' }> => c.kind === 'stone');
  if (stones.length > 0) {
    return stones.reduce((lowest, c) => (c.value < lowest.value ? c : lowest));
  }
  return hand.find((c) => c.kind === 'seismo') ?? hand.find((c) => c.kind === 'cool');
}
