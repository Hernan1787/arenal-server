import type { StoneValue } from './types.js';

export interface DeckComposition {
  readonly stones: Readonly<Record<StoneValue, number>>;
  readonly cool: number;
  readonly seismo: number;
}

/** Reglas configurables de Arenal. Los valores por defecto son los del documento de reglas. */
export interface ArenalConfig {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly startingLives: number;
  readonly handSize: number;
  /** Límite secreto mínimo de cada ronda (inclusive). */
  readonly limitMin: number;
  /** Límite secreto máximo de cada ronda (inclusive). */
  readonly limitMax: number;
  /** Cuánto baja la presión la carta Enfriar. */
  readonly coolAmount: number;
  /** El sismógrafo dice «cerca» si al límite le faltan esta cantidad o menos. */
  readonly seismoThreshold: number;
  /** Al terminar esta ronda, la partida termina por vidas. */
  readonly maxRounds: number;
  readonly deck: DeckComposition;
}

export const DEFAULT_CONFIG: ArenalConfig = {
  minPlayers: 2,
  maxPlayers: 5,
  startingLives: 3,
  handSize: 4,
  limitMin: 15,
  limitMax: 25,
  coolAmount: 3,
  seismoThreshold: 4,
  maxRounds: 15,
  deck: {
    stones: { 1: 10, 2: 10, 3: 8, 4: 6 },
    cool: 6,
    seismo: 4,
  },
};

export function deckSize(deck: DeckComposition): number {
  const { stones } = deck;
  return stones[1] + stones[2] + stones[3] + stones[4] + deck.cool + deck.seismo;
}

/** Devuelve la lista de problemas de la configuración; vacía si es válida. */
export function validateConfig(config: ArenalConfig): string[] {
  const problems: string[] = [];
  const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

  if (!Number.isInteger(config.minPlayers) || config.minPlayers < 2) {
    problems.push('minPlayers debe ser un entero de al menos 2');
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < config.minPlayers) {
    problems.push('maxPlayers debe ser un entero mayor o igual que minPlayers');
  }
  for (const key of ['startingLives', 'handSize', 'coolAmount', 'seismoThreshold', 'maxRounds'] as const) {
    if (!isPositiveInt(config[key])) problems.push(`${key} debe ser un entero positivo`);
  }
  if (!isPositiveInt(config.limitMin) || !Number.isInteger(config.limitMax) || config.limitMax < config.limitMin) {
    problems.push('limitMin y limitMax deben ser enteros positivos con limitMin <= limitMax');
  }
  const counts = [...Object.values(config.deck.stones), config.deck.cool, config.deck.seismo];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
    problems.push('las cantidades del mazo deben ser enteros no negativos');
  }
  // Con esto siempre hay al menos una carta para robar: la que se acaba de jugar va al descarte.
  if (deckSize(config.deck) < config.maxPlayers * config.handSize + 1) {
    problems.push('el mazo debe tener más cartas que maxPlayers × handSize');
  }
  return problems;
}
