import { DEFAULT_CONFIG, type ArenalConfig } from './config.js';
import type { Card, PlayerId } from './types.js';

export type EliminationReason = 'lives' | 'abandon';

export interface SeismoReading {
  readonly round: number;
  readonly near: boolean;
}

export interface PlayerState {
  readonly id: PlayerId;
  /** Posición en la mesa; define el orden de turnos. */
  readonly seat: number;
  readonly lives: number;
  readonly hand: readonly Card[];
  readonly eliminated: boolean;
  readonly eliminationReason: EliminationReason | null;
  readonly lastSeismo: SeismoReading | null;
}

export type MatchStatus = 'waiting' | 'playing' | 'finished';

export type MatchResult =
  | { readonly kind: 'winner'; readonly winner: PlayerId; readonly reason: 'last_standing' | 'most_lives' }
  | { readonly kind: 'draw'; readonly players: readonly PlayerId[]; readonly reason: 'tied_lives' | 'no_players' };

/**
 * Estado completo de una partida. Contiene información secreta (manos, mazo y límite):
 * nunca se envía tal cual a un jugador; para eso está `viewFor`.
 */
export interface GameState {
  readonly matchId: string;
  readonly config: ArenalConfig;
  readonly status: MatchStatus;
  /** Cantidad de eventos aplicados. El servidor la usa como número de secuencia. */
  readonly version: number;
  /** Jugadores ordenados por asiento. */
  readonly players: readonly PlayerState[];
  readonly round: number;
  /** Aumenta en cada turno; los temporizadores lo usan para no disparar sobre un turno viejo. */
  readonly turn: number;
  readonly currentPlayer: PlayerId | null;
  readonly pressure: number;
  /** Límite secreto de la ronda en curso. `null` entre rondas. */
  readonly limit: number | null;
  /** Límite de la última ronda terminada; ya es público. */
  readonly lastRevealedLimit: number | null;
  readonly drawPile: readonly Card[];
  readonly discard: readonly Card[];
  readonly result: MatchResult | null;
}

/** Partida creada pero sin empezar. El orden de la mesa se sortea al iniciar. */
export function createMatch(
  matchId: string,
  playerIds: readonly PlayerId[],
  config: ArenalConfig = DEFAULT_CONFIG,
): GameState {
  return {
    matchId,
    config,
    status: 'waiting',
    version: 0,
    players: playerIds.map((id, seat) => ({
      id,
      seat,
      lives: config.startingLives,
      hand: [],
      eliminated: false,
      eliminationReason: null,
      lastSeismo: null,
    })),
    round: 0,
    turn: 0,
    currentPlayer: null,
    pressure: 0,
    limit: null,
    lastRevealedLimit: null,
    drawPile: [],
    discard: [],
    result: null,
  };
}

export function findPlayer(state: GameState, playerId: PlayerId): PlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

export function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.eliminated);
}

/** El siguiente jugador vivo en el orden de la mesa después de `after`. */
export function nextAlivePlayer(state: GameState, after: PlayerId): PlayerId | null {
  const seats = state.players;
  const start = seats.findIndex((p) => p.id === after);
  if (start === -1) return null;
  for (let step = 1; step <= seats.length; step++) {
    const candidate = seats.at((start + step) % seats.length);
    if (candidate !== undefined && !candidate.eliminated && candidate.id !== after) return candidate.id;
  }
  return null;
}
