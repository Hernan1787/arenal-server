import type { Card, PlayerEvent } from '@arenal/domain';

/** Nombre de una carta para mostrar. */
export const cardName = (card: Card): string =>
  card.kind === 'stone' ? `Piedra ${card.value}` : card.kind === 'cool' ? 'Enfriar' : 'Sismógrafo';

/**
 * Una línea en español para cada evento que le importa a un jugador (o `null` si no hay nada que
 * contar). La usan el cliente de terminal y la web. `who` da el nombre de un jugador por su ID.
 */
export function describeEvent(event: PlayerEvent, me: string | null, who: (id: string) => string): string | null {
  const lives = (n: number): string => `${n} ${n === 1 ? 'vida' : 'vidas'}`;
  switch (event.type) {
    case 'MatchStarted':
      return `Empieza la partida. Orden: ${event.playerOrder.map(who).join(', ')}`;
    case 'RoundStarted':
      return `Ronda ${event.round}: el volcán tiene un límite nuevo (secreto)`;
    case 'CardPlayed': {
      const card = cardName(event.card);
      return event.playerId === me
        ? `Juegas ${card}${event.auto ? ' (se te venció el turno)' : ''}. Presión: ${event.pressureAfter}`
        : `${who(event.playerId)} juega ${card}${event.auto ? ' (se le venció el turno)' : ''}. Presión: ${event.pressureAfter}`;
    }
    case 'SeismoRead':
      return event.playerId === me && event.near !== undefined
        ? `Tu sismógrafo dice: ${event.near ? 'cerca del límite' : 'lejos del límite'}`
        : `${who(event.playerId)} consultó el sismógrafo`;
    case 'Eruption':
      if (event.livesLeft === 0) {
        return event.playerId === me
          ? `¡Erupción! El límite era ${event.limit}. Te quedaste sin vidas`
          : `¡Erupción! El límite era ${event.limit}. ${who(event.playerId)} se quedó sin vidas`;
      }
      return event.playerId === me
        ? `¡Erupción! El límite era ${event.limit}. Te ${event.livesLeft === 1 ? 'queda' : 'quedan'} ${lives(event.livesLeft)}`
        : `¡Erupción! El límite era ${event.limit}. ${who(event.playerId)} queda con ${lives(event.livesLeft)}`;
    case 'PlayerEliminated': {
      const why = event.reason === 'abandon' ? 'abandono' : 'sin vidas';
      return event.playerId === me ? `Quedaste fuera (${why})` : `${who(event.playerId)} queda fuera (${why})`;
    }
    case 'MatchEnded': {
      const r = event.result;
      if (r.kind === 'winner')
        return r.winner === me ? 'Fin de la partida. ¡Ganaste!' : `Fin de la partida. Gana ${who(r.winner)}`;
      if (r.kind === 'draw') return `Fin de la partida. Empate entre ${r.players.map(who).join(', ')}`;
      return 'Un administrador terminó la partida';
    }
    case 'DeckShuffled':
    case 'DiscardReshuffled':
    case 'CardDrawn':
    case 'TurnStarted':
      return null;
  }
}
