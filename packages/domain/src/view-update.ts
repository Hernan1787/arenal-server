import type { PlayerEvent } from './projection.js';
import type { Card, PlayerId } from './types.js';
import type { PlayerView, PublicPlayer } from './view.js';

function updatePlayer(view: PlayerView, playerId: PlayerId, change: (p: PublicPlayer) => PublicPlayer): PlayerView {
  return { ...view, players: view.players.map((p) => (p.id === playerId ? change(p) : p)) };
}

function withHand(view: PlayerView, change: (hand: readonly Card[]) => readonly Card[]): PlayerView {
  return view.you === null ? view : { ...view, you: { ...view.you, hand: change(view.you.hand) } };
}

/**
 * Aplica a la vista de un jugador un evento ya filtrado para él. Es el espejo de `evolve` del
 * lado del cliente: con el snapshot y los eventos que le llegan, el cliente sabe exactamente lo
 * mismo que le mostraría el servidor (`viewFor`), sin pedir el estado otra vez. Una prueba de
 * propiedades verifica esa igualdad en miles de partidas al azar.
 */
export function applyPlayerEvent(view: PlayerView, event: PlayerEvent): PlayerView {
  const next = applyEvent(view, event);
  return { ...next, version: view.version + 1 };
}

function applyEvent(view: PlayerView, event: PlayerEvent): PlayerView {
  const isMe = (playerId: PlayerId): boolean => view.you?.id === playerId;
  switch (event.type) {
    case 'MatchStarted': {
      const players = event.playerOrder.map((id, seat): PublicPlayer => {
        const existing = view.players.find((p) => p.id === id);
        return {
          id,
          seat,
          lives: view.rules.startingLives,
          handCount: existing?.handCount ?? 0,
          eliminated: existing?.eliminated ?? false,
          eliminationReason: existing?.eliminationReason ?? null,
        };
      });
      return { ...view, status: 'playing', players };
    }

    case 'DeckShuffled':
    case 'DiscardReshuffled':
      return { ...view, drawPileCount: event.count, discardCount: 0 };

    case 'CardDrawn': {
      const { card } = event;
      const drawn = updatePlayer({ ...view, drawPileCount: view.drawPileCount - 1 }, event.playerId, (p) => ({
        ...p,
        handCount: p.handCount + 1,
      }));
      return isMe(event.playerId) && card !== undefined ? withHand(drawn, (hand) => [...hand, card]) : drawn;
    }

    case 'RoundStarted':
      return {
        ...view,
        round: event.round,
        pressure: 0,
        // La lectura del sismógrafo es de la ronda en que se pidió.
        you: view.you === null ? null : { ...view.you, seismo: null },
      };

    case 'TurnStarted':
      return { ...view, currentPlayer: event.playerId, turn: event.turn };

    case 'CardPlayed': {
      const played = updatePlayer(
        { ...view, pressure: event.pressureAfter, discardCount: view.discardCount + 1 },
        event.playerId,
        (p) => ({ ...p, handCount: p.handCount - 1 }),
      );
      return isMe(event.playerId) ? withHand(played, (hand) => hand.filter((c) => c.id !== event.card.id)) : played;
    }

    case 'SeismoRead': {
      const { near } = event;
      return isMe(event.playerId) && near !== undefined && view.you !== null
        ? { ...view, you: { ...view.you, seismo: { near } } }
        : view;
    }

    case 'Eruption':
      return {
        ...updatePlayer(view, event.playerId, (p) => ({ ...p, lives: event.livesLeft })),
        lastRevealedLimit: event.limit,
        currentPlayer: null,
      };

    case 'PlayerEliminated': {
      const eliminated = updatePlayer(
        {
          ...view,
          discardCount: view.discardCount + event.discardedCount,
          currentPlayer: view.currentPlayer === event.playerId ? null : view.currentPlayer,
        },
        event.playerId,
        (p) => ({ ...p, handCount: 0, eliminated: true, eliminationReason: event.reason }),
      );
      return isMe(event.playerId) ? withHand(eliminated, () => []) : eliminated;
    }

    case 'MatchEnded':
      return { ...view, status: 'finished', result: event.result, currentPlayer: null };
  }
}
