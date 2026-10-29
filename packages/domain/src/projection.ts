import type { DomainEvent } from './events.js';
import type { EliminationReason, MatchResult } from './state.js';
import type { Card, PlayerId } from './types.js';

/**
 * Versión de un evento que se le puede mandar a un jugador concreto. Cada evento del
 * dominio tiene su versión pública (nunca se omite), así cada jugador recibe todos los
 * números de secuencia sin huecos y puede detectar si perdió alguno.
 */
export type PlayerEvent =
  | { readonly type: 'MatchStarted'; readonly playerOrder: readonly PlayerId[] }
  | { readonly type: 'DeckShuffled'; readonly count: number }
  | { readonly type: 'CardDrawn'; readonly playerId: PlayerId; readonly card?: Card }
  | { readonly type: 'RoundStarted'; readonly round: number; readonly firstPlayer: PlayerId }
  | { readonly type: 'TurnStarted'; readonly playerId: PlayerId; readonly turn: number }
  | {
      readonly type: 'CardPlayed';
      readonly playerId: PlayerId;
      readonly card: Card;
      readonly pressureAfter: number;
      readonly auto: boolean;
    }
  | { readonly type: 'SeismoRead'; readonly playerId: PlayerId; readonly near?: boolean }
  | { readonly type: 'Eruption'; readonly playerId: PlayerId; readonly limit: number; readonly livesLeft: number }
  | {
      readonly type: 'PlayerEliminated';
      readonly playerId: PlayerId;
      readonly reason: EliminationReason;
      readonly discardedCount: number;
    }
  | { readonly type: 'DiscardReshuffled'; readonly count: number }
  | { readonly type: 'MatchEnded'; readonly result: MatchResult };

/**
 * Filtra un evento para quien lo va a recibir. Lo que queda oculto:
 * el orden del mazo, las cartas que roban los demás, el límite de la ronda en curso,
 * la lectura del sismógrafo de otro jugador y las cartas que tenía un jugador eliminado.
 * Las cartas jugadas y el límite de una ronda terminada sí son públicos.
 */
export function projectEvent(event: DomainEvent, viewerId: PlayerId | null): PlayerEvent {
  switch (event.type) {
    case 'DeckShuffled':
      return { type: 'DeckShuffled', count: event.cards.length };
    case 'DiscardReshuffled':
      return { type: 'DiscardReshuffled', count: event.cards.length };
    case 'CardDrawn':
      return event.playerId === viewerId
        ? { type: 'CardDrawn', playerId: event.playerId, card: event.card }
        : { type: 'CardDrawn', playerId: event.playerId };
    case 'RoundStarted':
      return { type: 'RoundStarted', round: event.round, firstPlayer: event.firstPlayer };
    case 'SeismoRead':
      return event.playerId === viewerId
        ? { type: 'SeismoRead', playerId: event.playerId, near: event.near }
        : { type: 'SeismoRead', playerId: event.playerId };
    case 'PlayerEliminated':
      return {
        type: 'PlayerEliminated',
        playerId: event.playerId,
        reason: event.reason,
        discardedCount: event.discarded.length,
      };
    case 'MatchStarted':
    case 'TurnStarted':
    case 'CardPlayed':
    case 'Eruption':
    case 'MatchEnded':
      return event;
  }
}
