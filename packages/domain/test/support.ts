import {
  createMatch,
  decide,
  DEFAULT_CONFIG,
  replay,
  type ArenalConfig,
  type Card,
  type DomainEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type Rng,
} from '../src/index.js';

/** Generador con semilla (mulberry32): las pruebas son reproducibles. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (min, max) => min + Math.floor(next() * (max - min + 1)) };
}

/** Azar que siempre devuelve el mínimo: no baraja y sortea el límite más bajo. */
export const minRng: Rng = { int: (min) => min };

let counter = 0;
const id = (): string => `t_${(counter++).toString().padStart(4, '0')}`;

export const stone = (value: 1 | 2 | 3 | 4): Card => ({ id: id(), kind: 'stone', value });
export const cool = (): Card => ({ id: id(), kind: 'cool' });
export const seismo = (): Card => ({ id: id(), kind: 'seismo' });

export interface Setup {
  readonly hands: Readonly<Record<PlayerId, readonly Card[]>>;
  readonly drawPile?: readonly Card[];
  readonly discard?: readonly Card[];
  readonly limit: number;
  readonly lives?: Readonly<Record<PlayerId, number>>;
  readonly round?: number;
  readonly config?: Partial<ArenalConfig>;
}

/**
 * Arma una partida en curso con manos, mazo y límite elegidos, usando solo eventos
 * (así la prueba pasa por `evolve` igual que el servidor).
 */
export function setupMatch(s: Setup): { state: GameState; initial: GameState; events: DomainEvent[] } {
  const players = Object.keys(s.hands);
  const config: ArenalConfig = { ...DEFAULT_CONFIG, ...s.config };
  const initial = createMatch('m_test', players, config);
  const drawPile = s.drawPile ?? Array.from({ length: 10 }, () => stone(1));
  const handCards = players.flatMap((p) => s.hands[p] ?? []);
  const events: DomainEvent[] = [
    { type: 'MatchStarted', playerOrder: players },
    { type: 'DeckShuffled', cards: [...handCards, ...drawPile] },
  ];
  for (const p of players) {
    for (const card of s.hands[p] ?? []) events.push({ type: 'CardDrawn', playerId: p, card });
  }
  const first = players[0] ?? 'nadie';
  events.push({ type: 'RoundStarted', round: s.round ?? 1, limit: s.limit, firstPlayer: first });
  events.push({ type: 'TurnStarted', playerId: first, turn: 1 });

  let state = replay(initial, events);
  if (s.lives !== undefined) {
    state = { ...state, players: state.players.map((p) => ({ ...p, lives: s.lives?.[p.id] ?? p.lives })) };
  }
  if (s.discard !== undefined) state = { ...state, discard: s.discard };
  return { state, initial, events };
}

/** Ejecuta una intención y falla la prueba si las reglas la rechazan. */
export function act(state: GameState, intent: Intent, rng: Rng = minRng): { state: GameState; events: DomainEvent[] } {
  const result = decide(state, intent, { rng });
  if (!result.ok) throw new Error(`Intención rechazada: ${result.error.code} — ${result.error.message}`);
  return { state: replay(state, result.value), events: result.value };
}

export function errorCode(state: GameState, intent: Intent, rng: Rng = minRng): string | null {
  const result = decide(state, intent, { rng });
  return result.ok ? null : result.error.code;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function player(state: GameState, playerId: PlayerId): GameState['players'][number] {
  const found = state.players.find((p) => p.id === playerId);
  if (found === undefined) throw new Error(`No existe el jugador ${playerId}`);
  return found;
}
