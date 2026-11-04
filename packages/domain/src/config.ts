import type { StoneValue } from './types.js';

export interface DeckComposition {
  readonly stones: Readonly<Record<StoneValue, number>>;
  readonly bomb: number;
  readonly quake: number;
  readonly cool: number;
  readonly rain: number;
  readonly seismo: number;
  readonly divert: number;
  readonly ash: number;
  readonly steal: number;
  readonly shield: number;
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
  /** Cuánto baja la presión la carta Lluvia. */
  readonly rainAmount: number;
  /** Cuánto sube la presión la Bomba. */
  readonly bombAmount: number;
  /** El Temblor sube la presión un número al azar entre estos dos (inclusive). */
  readonly quakeMin: number;
  readonly quakeMax: number;
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
  rainAmount: 5,
  bombAmount: 5,
  quakeMin: 1,
  quakeMax: 4,
  seismoThreshold: 4,
  maxRounds: 15,
  deck: {
    stones: { 1: 10, 2: 10, 3: 8, 4: 6 },
    bomb: 3,
    quake: 4,
    cool: 4,
    rain: 2,
    seismo: 4,
    divert: 3,
    ash: 3,
    steal: 3,
    shield: 2,
  },
};

const SPECIAL_KINDS = ['bomb', 'quake', 'cool', 'rain', 'seismo', 'divert', 'ash', 'steal', 'shield'] as const;

export function deckSize(deck: DeckComposition): number {
  const { stones } = deck;
  return stones[1] + stones[2] + stones[3] + stones[4] + SPECIAL_KINDS.reduce((n, kind) => n + deck[kind], 0);
}

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * Completa una configuración guardada con los valores por defecto. Las partidas viejas se
 * guardaron antes de que existieran las cartas nuevas: sin esto, su configuración no tendría
 * esos campos. Las cantidades del mazo que falten quedan en 0, porque esa partida ya barajó su
 * mazo sin esas cartas.
 */
export function completeConfig(stored: DeepPartial<ArenalConfig>): ArenalConfig {
  const deck = stored.deck ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    deck: {
      stones: { ...DEFAULT_CONFIG.deck.stones, ...deck.stones },
      bomb: deck.bomb ?? 0,
      quake: deck.quake ?? 0,
      cool: deck.cool ?? DEFAULT_CONFIG.deck.cool,
      rain: deck.rain ?? 0,
      seismo: deck.seismo ?? DEFAULT_CONFIG.deck.seismo,
      divert: deck.divert ?? 0,
      ash: deck.ash ?? 0,
      steal: deck.steal ?? 0,
      shield: deck.shield ?? 0,
    },
  };
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
  for (const key of [
    'startingLives',
    'handSize',
    'coolAmount',
    'rainAmount',
    'bombAmount',
    'seismoThreshold',
    'maxRounds',
  ] as const) {
    if (!isPositiveInt(config[key])) problems.push(`${key} debe ser un entero positivo`);
  }
  if (!isPositiveInt(config.limitMin) || !Number.isInteger(config.limitMax) || config.limitMax < config.limitMin) {
    problems.push('limitMin y limitMax deben ser enteros positivos con limitMin <= limitMax');
  }
  if (!isPositiveInt(config.quakeMin) || !Number.isInteger(config.quakeMax) || config.quakeMax < config.quakeMin) {
    problems.push('quakeMin y quakeMax deben ser enteros positivos con quakeMin <= quakeMax');
  }
  const counts = [...Object.values(config.deck.stones), ...SPECIAL_KINDS.map((kind) => config.deck[kind])];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
    problems.push('las cantidades del mazo deben ser enteros no negativos');
  }
  // Con esto siempre hay al menos una carta para robar: la que se acaba de jugar va al descarte.
  if (deckSize(config.deck) < config.maxPlayers * config.handSize + 1) {
    problems.push('el mazo debe tener más cartas que maxPlayers × handSize');
  }
  return problems;
}
