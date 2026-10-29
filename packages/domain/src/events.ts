import type { EliminationReason, MatchResult } from './state.js';
import type { Card, PlayerId } from './types.js';

/**
 * Hechos que ya ocurrieron. Todo lo que fue decidido por azar queda dentro del evento
 * (el orden del mazo, el límite de la ronda), así la partida se reproduce jugada por
 * jugada sin volver a sortear nada. Varios eventos llevan información secreta:
 * para mandarlos a un jugador se usa `projectEvent`.
 */
export type DomainEvent =
  | { readonly type: 'MatchStarted'; readonly playerOrder: readonly PlayerId[] }
  | { readonly type: 'DeckShuffled'; readonly cards: readonly Card[] }
  | { readonly type: 'CardDrawn'; readonly playerId: PlayerId; readonly card: Card }
  | { readonly type: 'RoundStarted'; readonly round: number; readonly limit: number; readonly firstPlayer: PlayerId }
  | { readonly type: 'TurnStarted'; readonly playerId: PlayerId; readonly turn: number }
  | {
      readonly type: 'CardPlayed';
      readonly playerId: PlayerId;
      readonly card: Card;
      readonly pressureAfter: number;
      /** `true` si la jugó el servidor porque venció el turno. */
      readonly auto: boolean;
    }
  | { readonly type: 'SeismoRead'; readonly playerId: PlayerId; readonly near: boolean }
  | { readonly type: 'Eruption'; readonly playerId: PlayerId; readonly limit: number; readonly livesLeft: number }
  | {
      readonly type: 'PlayerEliminated';
      readonly playerId: PlayerId;
      readonly reason: EliminationReason;
      readonly discarded: readonly Card[];
    }
  | { readonly type: 'DiscardReshuffled'; readonly cards: readonly Card[] }
  | { readonly type: 'MatchEnded'; readonly result: MatchResult };

export type DomainEventType = DomainEvent['type'];
