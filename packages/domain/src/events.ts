import type { EliminationReason, MatchResult } from './state.js';
import type { Card, PlayerId } from './types.js';

/**
 * Hechos que ya ocurrieron. Todo lo que fue decidido por azar queda dentro del evento
 * (el orden del mazo, el límite de la ronda, el número del Temblor, la carta que se ve con
 * Ceniza o la que se roba), así la partida se reproduce jugada por jugada sin volver a sortear
 * nada. Varios eventos llevan información secreta: para mandarlos a un jugador se usa
 * `projectEvent`.
 *
 * Los campos opcionales existen porque hay partidas guardadas de antes de las cartas nuevas: un
 * evento viejo sin ese campo se lee con el valor que tenía la regla entonces.
 */
export type DomainEvent =
  | { readonly type: 'MatchStarted'; readonly playerOrder: readonly PlayerId[] }
  | { readonly type: 'DeckShuffled'; readonly cards: readonly Card[] }
  | { readonly type: 'CardDrawn'; readonly playerId: PlayerId; readonly card: Card }
  | { readonly type: 'RoundStarted'; readonly round: number; readonly limit: number; readonly firstPlayer: PlayerId }
  | {
      readonly type: 'TurnStarted';
      readonly playerId: PlayerId;
      readonly turn: number;
      /** Cartas que tiene que jugar en este turno: 2 después de un Desvío. Si falta, 1. */
      readonly playsLeft?: number;
    }
  | {
      readonly type: 'CardPlayed';
      readonly playerId: PlayerId;
      readonly card: Card;
      readonly pressureAfter: number;
      /** `true` si la jugó el servidor porque venció el turno. */
      readonly auto: boolean;
      /** Contra quién se jugó (Ceniza y Robo). */
      readonly targetId?: PlayerId;
      /** Cuánto sorteó el servidor para el Temblor. */
      readonly rolled?: number;
    }
  | { readonly type: 'SeismoRead'; readonly playerId: PlayerId; readonly near: boolean }
  /** Ceniza: `playerId` vio esa carta de la mano de `targetId`. */
  | { readonly type: 'CardPeeked'; readonly playerId: PlayerId; readonly targetId: PlayerId; readonly card: Card }
  /** Robo: la carta pasa de la mano de `targetId` a la de `playerId`. */
  | { readonly type: 'CardStolen'; readonly playerId: PlayerId; readonly targetId: PlayerId; readonly card: Card }
  | {
      readonly type: 'Eruption';
      readonly playerId: PlayerId;
      readonly limit: number;
      readonly livesLeft: number;
      /** `true` si el Escudo de quien la provocó aguantó la erupción (y se gastó). */
      readonly shielded?: boolean;
    }
  | {
      readonly type: 'PlayerEliminated';
      readonly playerId: PlayerId;
      readonly reason: EliminationReason;
      readonly discarded: readonly Card[];
    }
  | { readonly type: 'DiscardReshuffled'; readonly cards: readonly Card[] }
  | { readonly type: 'MatchEnded'; readonly result: MatchResult };

export type DomainEventType = DomainEvent['type'];
