import type { CardId, PlayerId } from './types.js';

/**
 * Intenciones: lo que alguien quiere hacer. El cliente solo puede mandar `play_card`;
 * las demás las genera el propio servidor (al llenarse la sala, al vencer un temporizador
 * o al vencer el periodo de gracia de una desconexión).
 */
export type Intent =
  | { readonly type: 'start' }
  | { readonly type: 'play_card'; readonly playerId: PlayerId; readonly cardId: CardId }
  | { readonly type: 'turn_timeout'; readonly playerId: PlayerId; readonly turn: number }
  | { readonly type: 'abandon'; readonly playerId: PlayerId };

export type IntentType = Intent['type'];
