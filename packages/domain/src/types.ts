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
  | { readonly id: CardId; readonly kind: 'cool' }
  | { readonly id: CardId; readonly kind: 'seismo' };

export type CardKind = Card['kind'];

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
