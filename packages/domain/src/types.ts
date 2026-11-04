/** Identificador de un jugador dentro de una partida (el ID de usuario). */
export type PlayerId = string;

/**
 * Identificador opaco de una carta. Es aleatorio por partida (por ejemplo `c_8f3k2a`)
 * para que el ID nunca revele qué carta es.
 */
export type CardId = string;

export type StoneValue = 1 | 2 | 3 | 4;

export type Card =
  | { readonly id: CardId; readonly kind: 'stone'; readonly value: StoneValue }
  /** Bomba: la presión sube mucho (`bombAmount`). */
  | { readonly id: CardId; readonly kind: 'bomb' }
  /** Temblor: la presión sube un número que sortea el servidor al jugarla. */
  | { readonly id: CardId; readonly kind: 'quake' }
  | { readonly id: CardId; readonly kind: 'cool' }
  /** Lluvia: la presión baja más que con Enfriar (`rainAmount`). */
  | { readonly id: CardId; readonly kind: 'rain' }
  | { readonly id: CardId; readonly kind: 'seismo' }
  /** Desvío: la presión no cambia y el siguiente jugador juega dos cartas. */
  | { readonly id: CardId; readonly kind: 'divert' }
  /** Ceniza: ves en secreto una carta al azar de un rival. */
  | { readonly id: CardId; readonly kind: 'ash' }
  /** Robo: le quitas una carta al azar a un rival; él roba otra del mazo. */
  | { readonly id: CardId; readonly kind: 'steal' }
  /** Escudo: la próxima erupción que provoques no te quita vida. */
  | { readonly id: CardId; readonly kind: 'shield' };

export type CardKind = Card['kind'];

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * Una carta sin su ID: lo que se ve de una carta ajena con Ceniza. Sin el ID, quien mira no
 * puede seguirle la pista a esa carta después (ni saber si la juegan o la roban).
 */
export type CardFace = WithoutId<Card>;

export const faceOf = (card: Card): CardFace =>
  card.kind === 'stone' ? { kind: 'stone', value: card.value } : { kind: card.kind };

/** Cartas que se juegan contra un rival: la jugada tiene que decir contra quién. */
export const needsTarget = (card: Pick<Card, 'kind'>): boolean => card.kind === 'ash' || card.kind === 'steal';

export type RuleErrorCode =
  | 'INVALID_CONFIG'
  | 'ALREADY_STARTED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'TOO_MANY_PLAYERS'
  | 'DUPLICATE_PLAYER'
  | 'MATCH_NOT_STARTED'
  | 'MATCH_FINISHED'
  | 'NOT_A_PLAYER'
  | 'PLAYER_ELIMINATED'
  | 'NOT_YOUR_TURN'
  | 'CARD_NOT_IN_HAND'
  | 'TARGET_REQUIRED'
  | 'INVALID_TARGET'
  | 'SHIELD_ACTIVE'
  | 'STALE_TIMER';

export interface RuleError {
  readonly code: RuleErrorCode;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RuleError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T>(code: RuleErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});

/** Se lanza solo si los eventos no son coherentes con el estado (datos corruptos). */
export class DomainInvariantError extends Error {
  override readonly name = 'DomainInvariantError';
}
