import type { DomainEvent } from './events.js';
import type { GameState, PlayerState } from './state.js';
import { DomainInvariantError, type Card, type PlayerId } from './types.js';

function updatePlayer(state: GameState, playerId: PlayerId, change: (p: PlayerState) => PlayerState): GameState {
  if (!state.players.some((p) => p.id === playerId)) {
    throw new DomainInvariantError(`El jugador ${playerId} no está en la partida ${state.matchId}`);
  }
  return { ...state, players: state.players.map((p) => (p.id === playerId ? change(p) : p)) };
}

function removeFromHand(player: PlayerState, card: Card): PlayerState {
  const index = player.hand.findIndex((c) => c.id === card.id);
  if (index === -1) throw new DomainInvariantError(`La carta ${card.id} no está en la mano de ${player.id}`);
  return { ...player, hand: player.hand.filter((_, i) => i !== index) };
}

/**
 * Aplica un evento al estado. Es pura y determinista: con el estado inicial y la lista
 * de eventos se reconstruye cualquier partida (durabilidad y repetición jugada por jugada).
 */
export function evolve(state: GameState, event: DomainEvent): GameState {
  const next = applyEvent(state, event);
  return { ...next, version: state.version + 1 };
}

function applyEvent(state: GameState, event: DomainEvent): GameState {
  switch (event.type) {
    case 'MatchStarted': {
      const players = event.playerOrder.map((id, seat): PlayerState => {
        const existing = state.players.find((p) => p.id === id);
        if (existing === undefined) throw new DomainInvariantError(`El jugador ${id} no estaba en la sala`);
        return { ...existing, seat, lives: state.config.startingLives };
      });
      return { ...state, status: 'playing', players };
    }

    case 'DeckShuffled':
      return { ...state, drawPile: event.cards, discard: [] };

    case 'CardDrawn': {
      const [top, ...rest] = state.drawPile;
      if (top?.id !== event.card.id) {
        throw new DomainInvariantError(`La carta robada ${event.card.id} no es la de arriba del mazo`);
      }
      const withPile = { ...state, drawPile: rest };
      return updatePlayer(withPile, event.playerId, (p) => ({ ...p, hand: [...p.hand, top] }));
    }

    case 'RoundStarted':
      return { ...state, round: event.round, limit: event.limit, pressure: 0 };

    case 'TurnStarted':
      return { ...state, currentPlayer: event.playerId, turn: event.turn };

    case 'CardPlayed': {
      const withHand = updatePlayer(state, event.playerId, (p) => removeFromHand(p, event.card));
      return { ...withHand, discard: [...state.discard, event.card], pressure: event.pressureAfter };
    }

    case 'SeismoRead':
      return updatePlayer(state, event.playerId, (p) => ({
        ...p,
        lastSeismo: { round: state.round, near: event.near },
      }));

    case 'Eruption': {
      const withLives = updatePlayer(state, event.playerId, (p) => ({ ...p, lives: event.livesLeft }));
      return { ...withLives, limit: null, lastRevealedLimit: event.limit, currentPlayer: null };
    }

    case 'PlayerEliminated': {
      const player = state.players.find((p) => p.id === event.playerId);
      if (player === undefined) throw new DomainInvariantError(`El jugador ${event.playerId} no está en la partida`);
      const withPlayer = updatePlayer(state, event.playerId, (p) => ({
        ...p,
        hand: [],
        eliminated: true,
        eliminationReason: event.reason,
      }));
      return {
        ...withPlayer,
        discard: [...state.discard, ...player.hand],
        currentPlayer: state.currentPlayer === event.playerId ? null : state.currentPlayer,
      };
    }

    case 'DiscardReshuffled':
      return { ...state, drawPile: event.cards, discard: [] };

    case 'MatchEnded':
      return { ...state, status: 'finished', result: event.result, currentPlayer: null };
  }
}

/** Reconstruye el estado a partir del estado inicial y todos sus eventos. */
export function replay(initial: GameState, events: readonly DomainEvent[]): GameState {
  return events.reduce(evolve, initial);
}
