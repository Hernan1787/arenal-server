import type { Card, PlayerView } from '@arenal/domain';

/**
 * Estrategia simple del bot. Mientras la presión más la piedra no pase del límite mínimo
 * posible, juega la piedra más alta: es seguro. Si no, se guía por el sismógrafo: «cerca»
 * enfría, sin lectura lo usa, «lejos» se arriesga con la piedra más baja.
 */
export function chooseCard(view: PlayerView): Card | undefined {
  const hand = view.you?.hand ?? [];
  const stones = hand
    .filter((c): c is Extract<Card, { kind: 'stone' }> => c.kind === 'stone')
    .sort((a, b) => b.value - a.value);
  const safe = stones.find((c) => view.pressure + c.value <= view.rules.limitMin);
  if (safe !== undefined) return safe;
  const cool = hand.find((c) => c.kind === 'cool');
  const seismo = hand.find((c) => c.kind === 'seismo');
  const lowest = stones.at(-1);
  const near = view.you?.seismo?.near;
  const order =
    near === true ? [cool, seismo, lowest] : near === false ? [lowest, cool, seismo] : [seismo, cool, lowest];
  return order.find((c) => c !== undefined) ?? hand[0];
}

/** ¿Le toca jugar a este jugador? */
export const isMyTurn = (view: PlayerView | null): view is PlayerView =>
  view !== null && view.status === 'playing' && view.you !== null && view.currentPlayer === view.you.id;
