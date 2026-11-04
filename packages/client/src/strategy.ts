import { needsTarget, type Card, type PlayerView } from '@arenal/domain';

/** Una jugada: la carta y, si se juega contra alguien (Ceniza, Robo), el rival. */
export interface CardPlay {
  readonly card: Card;
  readonly targetId?: string;
}

/** Rivales contra los que se puede jugar Ceniza o Robo: vivos y con cartas. */
export function validTargets(view: PlayerView): string[] {
  const me = view.you?.id;
  return view.players.filter((p) => p.id !== me && !p.eliminated && p.handCount > 0).map((p) => p.id);
}

/** ¿Se puede jugar esta carta ahora? (Un segundo Escudo no, y Ceniza o Robo necesitan a quién.) */
export function isPlayable(view: PlayerView, card: Card): boolean {
  const shielded = view.players.find((p) => p.id === view.you?.id)?.shielded === true;
  if (card.kind === 'shield' && shielded) return false;
  return !needsTarget(card) || validTargets(view).length > 0;
}

/** Cuánto puede subir la presión esta carta en el peor caso (`null` si no la sube). */
function worstRaise(view: PlayerView, card: Card): number | null {
  switch (card.kind) {
    case 'stone':
      return card.value;
    case 'bomb':
      return view.rules.bombAmount;
    case 'quake':
      return view.rules.quakeMax;
    case 'cool':
    case 'rain':
    case 'seismo':
    case 'divert':
    case 'ash':
    case 'steal':
    case 'shield':
      return null;
  }
}

/**
 * Estrategia simple del bot. Mientras la presión más la carta no pase del límite mínimo posible,
 * sube lo más que pueda: es seguro y le deja el problema al siguiente. Si no, se guía por el
 * sismógrafo: «cerca» se defiende (Desvío, Lluvia, Enfriar, Escudo, Robo, Ceniza), sin lectura lo
 * usa, «lejos» se arriesga con lo que menos sube. Contra quien juega es el rival con más vidas.
 */
export function choosePlay(view: PlayerView): CardPlay | undefined {
  const me = view.you;
  if (me === null) return undefined;
  const leader = view.players
    .filter((p) => validTargets(view).includes(p.id))
    .sort((a, b) => b.lives - a.lives || b.handCount - a.handCount)[0]?.id;
  const hand = me.hand.filter((c) => isPlayable(view, c));
  const toPlay = (card: Card | undefined): CardPlay | undefined =>
    card === undefined ? undefined : needsTarget(card) && leader !== undefined ? { card, targetId: leader } : { card };

  const margin = view.rules.limitMin - view.pressure;
  const raises = hand
    .map((card) => ({ card, raise: worstRaise(view, card) }))
    .filter((r): r is { card: Card; raise: number } => r.raise !== null)
    .sort((a, b) => b.raise - a.raise);
  const safe = raises.find((r) => r.raise <= margin);
  if (safe !== undefined) return toPlay(safe.card);

  const find = (kind: Card['kind']): Card | undefined => hand.find((c) => c.kind === kind);
  const defensive = [find('divert'), find('rain'), find('cool'), find('shield'), find('steal'), find('ash')];
  const lowest = raises.at(-1)?.card;
  const near = me.seismo?.near;
  const order =
    near === true
      ? [...defensive, find('seismo'), lowest]
      : near === false
        ? [lowest, ...defensive, find('seismo')]
        : [find('seismo'), ...defensive, lowest];
  return toPlay(order.find((c) => c !== undefined) ?? hand[0]);
}

/** ¿Le toca jugar a este jugador? */
export const isMyTurn = (view: PlayerView | null): view is PlayerView =>
  view !== null && view.status === 'playing' && view.you !== null && view.currentPlayer === view.you.id;
