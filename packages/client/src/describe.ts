import type { CardFace, PlayerEvent, PublicRules } from '@arenal/domain';

const NAMES: Readonly<Record<Exclude<CardFace['kind'], 'stone'>, string>> = {
  bomb: 'Bomba',
  quake: 'Temblor',
  cool: 'Enfriar',
  rain: 'Lluvia',
  seismo: 'Sismógrafo',
  divert: 'Desvío',
  ash: 'Ceniza',
  steal: 'Robo',
  shield: 'Escudo',
};

/** Nombre de una carta para mostrar. */
export const cardName = (card: CardFace): string => (card.kind === 'stone' ? `Piedra ${card.value}` : NAMES[card.kind]);

/** Qué hace una carta, en una frase. */
export function cardHelp(card: CardFace, rules: PublicRules): string {
  switch (card.kind) {
    case 'stone':
      return `Sube la presión ${card.value}.`;
    case 'bomb':
      return `Sube la presión ${rules.bombAmount}.`;
    case 'quake':
      return `Sube la presión entre ${rules.quakeMin} y ${rules.quakeMax}; el número lo sortea el servidor.`;
    case 'cool':
      return `Baja la presión ${rules.coolAmount}.`;
    case 'rain':
      return `Baja la presión ${rules.rainAmount}.`;
    case 'seismo':
      return `Te dice, solo a ti, si al límite le faltan ${rules.seismoThreshold} o menos.`;
    case 'divert':
      return 'No sube la presión y el siguiente jugador tiene que jugar dos cartas.';
    case 'ash':
      return 'Ves en secreto una carta al azar de un rival.';
    case 'steal':
      return 'Le quitas una carta al azar a un rival; él roba otra del mazo.';
    case 'shield':
      return 'La próxima erupción que provoques no te quita vida.';
  }
}

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
    case 'TurnStarted':
      if (event.playsLeft !== 2) return null;
      return event.playerId === me
        ? 'Desvío: te toca jugar dos cartas'
        : `Desvío: ${who(event.playerId)} juega dos cartas`;
    case 'CardPlayed': {
      const card = cardName(event.card);
      const target =
        event.targetId === undefined ? '' : ` contra ${event.targetId === me ? 'ti' : who(event.targetId)}`;
      const rolled = event.rolled === undefined ? '' : ` (+${event.rolled})`;
      const timeout = event.auto
        ? event.playerId === me
          ? ' (se te venció el turno)'
          : ' (se le venció el turno)'
        : '';
      const subject = event.playerId === me ? 'Juegas' : `${who(event.playerId)} juega`;
      return `${subject} ${card}${target}${rolled}${timeout}. Presión: ${event.pressureAfter}`;
    }
    case 'SeismoRead':
      return event.playerId === me && event.near !== undefined
        ? `Tu sismógrafo dice: ${event.near ? 'cerca del límite' : 'lejos del límite'}`
        : `${who(event.playerId)} consultó el sismógrafo`;
    case 'CardPeeked': {
      const { card } = event;
      if (event.playerId === me && card !== undefined)
        return `Ves en la mano de ${who(event.targetId)}: ${cardName(card)}`;
      if (event.targetId === me && card !== undefined) return `${who(event.playerId)} vio tu ${cardName(card)}`;
      return `${who(event.playerId)} miró una carta de ${who(event.targetId)}`;
    }
    case 'CardStolen': {
      const { card } = event;
      if (event.playerId === me && card !== undefined) return `Le robas a ${who(event.targetId)}: ${cardName(card)}`;
      if (event.targetId === me && card !== undefined) return `${who(event.playerId)} te robó: ${cardName(card)}`;
      return `${who(event.playerId)} le robó una carta a ${who(event.targetId)}`;
    }
    case 'Eruption':
      if (event.shielded === true) {
        return event.playerId === me
          ? `¡Erupción! El límite era ${event.limit}. Tu escudo aguantó: no pierdes vida`
          : `¡Erupción! El límite era ${event.limit}. El escudo de ${who(event.playerId)} aguantó`;
      }
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
      return null;
  }
}
