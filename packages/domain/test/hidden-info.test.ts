import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createMatch,
  decide,
  deckSize,
  DEFAULT_CONFIG,
  evolve,
  projectEvent,
  replay,
  viewFor,
  type DomainEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type Rng,
} from '../src/index.js';
import { seededRng } from './support.js';

const CARD_ID = /c_[0-9a-z]{6}/g;

const cardIdsIn = (value: unknown): Set<string> => new Set(JSON.stringify(value).match(CARD_ID) ?? []);

const handIds = (state: GameState, playerId: PlayerId): Set<string> =>
  new Set(state.players.find((p) => p.id === playerId)?.hand.map((c) => c.id) ?? []);

/** Elige una intención al azar entre las que podría generar el sistema o un jugador honesto. */
function randomIntent(state: GameState, chooser: Rng): Intent {
  const current = state.currentPlayer;
  const roll = chooser.int(0, 999);
  if (roll === 0) return { type: 'terminate' };
  const alive = state.players.filter((p) => !p.eliminated);
  if (roll < 30) {
    const leaver = alive[chooser.int(0, alive.length - 1)];
    if (leaver !== undefined) return { type: 'abandon', playerId: leaver.id };
  }
  if (current === null) throw new Error('Partida en curso sin jugador de turno');
  if (roll < 100) return { type: 'turn_timeout', playerId: current, turn: state.turn };
  const hand = state.players.find((p) => p.id === current)?.hand ?? [];
  const card = hand[chooser.int(0, hand.length - 1)];
  if (card === undefined) throw new Error('El jugador de turno no tiene cartas');
  return { type: 'play_card', playerId: current, cardId: card.id };
}

interface Step {
  readonly before: GameState;
  readonly event: DomainEvent;
  readonly after: GameState;
}

/** Juega una partida completa al azar y devuelve cada evento con el estado antes y después. */
function simulate(players: number, seed: number, maxIntents = 3000): { steps: Step[]; final: GameState } {
  const ids = Array.from({ length: players }, (_, i) => `jugador_${i}`);
  const initial = createMatch(`m_${seed}`, ids);
  const gameRng = seededRng(seed);
  const chooser = seededRng(seed ^ 0x5bd1e995);
  const steps: Step[] = [];

  let state = initial;
  const apply = (events: readonly DomainEvent[]): void => {
    for (const event of events) {
      const after = evolve(state, event);
      steps.push({ before: state, event, after });
      state = after;
    }
  };

  const started = decide(state, { type: 'start' }, { rng: gameRng });
  if (!started.ok) throw new Error(started.error.message);
  apply(started.value);

  for (let i = 0; i < maxIntents && state.status === 'playing'; i++) {
    const result = decide(state, randomIntent(state, chooser), { rng: gameRng });
    if (!result.ok) throw new Error(`Intención legal rechazada: ${result.error.code}`);
    apply(result.value);
  }
  return { steps, final: state };
}

const gameArb = fc.record({ players: fc.integer({ min: 2, max: 5 }), seed: fc.integer() });

describe('información oculta', () => {
  it('ninguna vista contiene cartas que no estén en la mano de quien mira, ni el límite secreto', () => {
    fc.assert(
      fc.property(gameArb, ({ players, seed }) => {
        const { steps } = simulate(players, seed);
        for (const { after } of steps) {
          for (const viewer of [...after.players.map((p) => p.id), null]) {
            const view = viewFor(after, viewer);
            const visible = cardIdsIn(view);
            const own = viewer === null ? new Set<string>() : handIds(after, viewer);
            for (const id of visible) expect(own.has(id)).toBe(true);
            expect(Object.keys(view)).not.toContain('limit');
            expect(view).not.toHaveProperty('drawPile');
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('ningún evento proyectado filtra cartas ajenas, el mazo, el límite en curso ni el sismógrafo de otro', () => {
    fc.assert(
      fc.property(gameArb, ({ players, seed }) => {
        const { steps } = simulate(players, seed);
        for (const { event, after } of steps) {
          const publicCard = event.type === 'CardPlayed' ? event.card.id : null;
          for (const viewer of [...after.players.map((p) => p.id), null]) {
            const projected = projectEvent(event, viewer);
            const own = viewer === null ? new Set<string>() : handIds(after, viewer);
            for (const id of cardIdsIn(projected)) expect(id === publicCard || own.has(id)).toBe(true);
            if (projected.type === 'RoundStarted') expect(projected).not.toHaveProperty('limit');
            if (projected.type === 'SeismoRead' && projected.playerId !== viewer) {
              expect(projected).not.toHaveProperty('near');
            }
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('invariantes en partidas al azar', () => {
  it('se conservan las cartas, la presión y las vidas nunca son negativas y siempre hay alguien de turno', () => {
    fc.assert(
      fc.property(gameArb, ({ players, seed }) => {
        const { steps, final } = simulate(players, seed);
        const total = deckSize(DEFAULT_CONFIG.deck);
        for (const { after, event } of steps) {
          if (event.type === 'MatchStarted') continue;
          const inHands = after.players.reduce((n, p) => n + p.hand.length, 0);
          expect(inHands + after.drawPile.length + after.discard.length).toBe(total);
          expect(after.pressure).toBeGreaterThanOrEqual(0);
          for (const p of after.players) expect(p.lives).toBeGreaterThanOrEqual(0);
        }
        if (final.status === 'playing') {
          const current = final.players.find((p) => p.id === final.currentPlayer);
          expect(current?.eliminated).toBe(false);
          expect(current?.hand).toHaveLength(DEFAULT_CONFIG.handSize);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('toda partida termina y se reproduce idéntica a partir de sus eventos', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const players = 2 + (seed % 4);
      const { steps, final } = simulate(players, seed);
      expect(final.status).toBe('finished');
      expect(final.result).not.toBeNull();
      const first = steps[0];
      if (first === undefined) throw new Error('sin eventos');
      expect(
        replay(
          first.before,
          steps.map((s) => s.event),
        ),
      ).toEqual(final);
    }
  });
});
