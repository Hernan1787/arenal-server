import { createMatch, decide, replay, viewFor, type Card, type GameState } from '@arenal/domain';
import { describe, expect, it } from 'vitest';
import { choosePlay, isMyTurn, isPlayable, validTargets } from '../src/strategy.js';

/** Azar con semilla (mulberry32): las cartas reciben IDs distintos y la prueba es reproducible. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return {
    int: (min: number, max: number): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
    },
  };
}
const rng = seeded(7);

function started(): GameState {
  const initial = createMatch('m', ['ana', 'beto']);
  const result = decide(initial, { type: 'start' }, { rng });
  if (!result.ok) throw new Error(result.error.message);
  return replay(initial, result.value);
}

const withHand = (state: GameState, hand: Card[], pressure: number): GameState => ({
  ...state,
  pressure,
  players: state.players.map((p) => (p.id === state.currentPlayer ? { ...p, hand } : p)),
});

const stone = (id: string, value: 1 | 2 | 3 | 4): Card => ({ id, kind: 'stone', value });

describe('estrategia del bot', () => {
  it('con presión baja juega la piedra más alta que no puede pasar el límite mínimo', () => {
    const state = withHand(started(), [stone('a', 1), stone('b', 4), stone('c', 3)], 8);
    expect(choosePlay(viewFor(state, state.currentPlayer))?.card.id).toBe('b');
  });

  it('cerca del límite y sin lectura usa el sismógrafo; con «cerca» enfría', () => {
    const base = started();
    const hand: Card[] = [stone('a', 4), { id: 's', kind: 'seismo' }, { id: 'f', kind: 'cool' }];
    const state = withHand(base, hand, 14);
    expect(choosePlay(viewFor(state, state.currentPlayer))?.card.id).toBe('s');
    const near = {
      ...state,
      players: state.players.map((p) =>
        p.id === state.currentPlayer ? { ...p, lastSeismo: { round: state.round, near: true } } : p,
      ),
    };
    expect(choosePlay(viewFor(near, near.currentPlayer))?.card.id).toBe('f');
  });

  it('con margen suficiente la Bomba también es segura, y sube más que una piedra', () => {
    const state = withHand(started(), [stone('a', 4), { id: 'b', kind: 'bomb' }], 6);
    expect(choosePlay(viewFor(state, state.currentPlayer))?.card.id).toBe('b');
    const tight = withHand(started(), [stone('a', 4), { id: 'b', kind: 'bomb' }], 8);
    expect(choosePlay(viewFor(tight, tight.currentPlayer))?.card.id).toBe('a');
  });

  it('en peligro se defiende con Desvío antes que con Enfriar, y Robo apunta al rival con más vidas', () => {
    const base = started();
    const state = withHand(base, [stone('a', 4), { id: 'f', kind: 'cool' }, { id: 'd', kind: 'divert' }], 16);
    const near = {
      ...state,
      players: state.players.map((p) =>
        p.id === state.currentPlayer ? { ...p, lastSeismo: { round: state.round, near: true } } : p,
      ),
    };
    expect(choosePlay(viewFor(near, near.currentPlayer))?.card.id).toBe('d');

    const thief = withHand(base, [stone('a', 4), { id: 'r', kind: 'steal' }], 16);
    const rival = thief.players.find((p) => p.id !== thief.currentPlayer)?.id;
    expect(choosePlay(viewFor(thief, thief.currentPlayer))).toEqual({
      card: { id: 'r', kind: 'steal' },
      targetId: rival,
    });
  });

  it('no juega un segundo Escudo', () => {
    const base = started();
    const state = withHand(base, [{ id: 'e', kind: 'shield' }, stone('a', 4)], 16);
    const covered = {
      ...state,
      players: state.players.map((p) => (p.id === state.currentPlayer ? { ...p, shielded: true } : p)),
    };
    const view = viewFor(covered, covered.currentPlayer);
    expect(isPlayable(view, { id: 'e', kind: 'shield' })).toBe(false);
    expect(choosePlay(view)?.card.id).toBe('a');
    expect(validTargets(view)).toHaveLength(1);
  });

  it('solo juega cuando es su turno y la partida está en curso', () => {
    const state = started();
    const other = state.players.find((p) => p.id !== state.currentPlayer)?.id ?? null;
    expect(isMyTurn(viewFor(state, state.currentPlayer))).toBe(true);
    expect(isMyTurn(viewFor(state, other))).toBe(false);
    expect(isMyTurn(null)).toBe(false);
  });
});
