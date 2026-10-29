import { describe, expect, it } from 'vitest';
import { createMatch, decide, DEFAULT_CONFIG, replay, type DomainEvent } from '../src/index.js';
import { act, cool, deepFreeze, errorCode, minRng, player, seededRng, seismo, setupMatch, stone } from './support.js';

const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.type);

describe('inicio de partida', () => {
  it('reparte 4 cartas a cada uno, sortea el límite y le da el turno al primero de la mesa', () => {
    const initial = createMatch('m1', ['ana', 'beto', 'caro']);
    const result = decide(initial, { type: 'start' }, { rng: seededRng(7) });
    if (!result.ok) throw new Error(result.error.message);
    const state = replay(initial, result.value);

    expect(state.status).toBe('playing');
    expect(state.players.map((p) => p.hand.length)).toEqual([4, 4, 4]);
    expect(state.drawPile).toHaveLength(44 - 12);
    expect(state.round).toBe(1);
    expect(state.limit).toBeGreaterThanOrEqual(DEFAULT_CONFIG.limitMin);
    expect(state.limit).toBeLessThanOrEqual(DEFAULT_CONFIG.limitMax);

    const started = result.value[0];
    expect(started?.type).toBe('MatchStarted');
    const order = started?.type === 'MatchStarted' ? started.playerOrder : [];
    expect(state.currentPlayer).toBe(order[0]);
    expect(state.players.map((p) => p.id)).toEqual(order);
  });

  it('crea 44 cartas con IDs únicos y opacos que no revelan qué carta son', () => {
    const initial = createMatch('m1', ['ana', 'beto']);
    const result = decide(initial, { type: 'start' }, { rng: seededRng(1) });
    if (!result.ok) throw new Error(result.error.message);
    const deck = result.value.find((e) => e.type === 'DeckShuffled');
    const cards = deck?.type === 'DeckShuffled' ? deck.cards : [];

    expect(cards).toHaveLength(44);
    expect(new Set(cards.map((c) => c.id)).size).toBe(44);
    for (const card of cards) expect(card.id).toMatch(/^c_[0-9a-z]{6}$/);
    expect(cards.filter((c) => c.kind === 'cool')).toHaveLength(6);
    expect(cards.filter((c) => c.kind === 'seismo')).toHaveLength(4);
  });

  it('rechaza menos de 2, más de 5, jugadores repetidos y empezar dos veces', () => {
    expect(errorCode(createMatch('m', ['ana']), { type: 'start' })).toBe('NOT_ENOUGH_PLAYERS');
    expect(errorCode(createMatch('m', ['a', 'b', 'c', 'd', 'e', 'f']), { type: 'start' })).toBe('TOO_MANY_PLAYERS');
    expect(errorCode(createMatch('m', ['ana', 'ana']), { type: 'start' })).toBe('DUPLICATE_PLAYER');

    const started = act(createMatch('m', ['ana', 'beto']), { type: 'start' }, seededRng(3)).state;
    expect(errorCode(started, { type: 'start' })).toBe('ALREADY_STARTED');
  });

  it('rechaza una configuración inválida', () => {
    const config = { ...DEFAULT_CONFIG, handSize: 20 };
    expect(errorCode(createMatch('m', ['ana', 'beto'], config), { type: 'start' })).toBe('INVALID_CONFIG');
  });
});

describe('jugar una carta', () => {
  const hands = () => ({
    ana: [stone(2), stone(1), cool(), seismo()],
    beto: [stone(3), stone(1), stone(1), stone(1)],
    caro: [stone(4), stone(1), stone(1), stone(1)],
  });

  it('una piedra sube la presión, el jugador roba y pasa el turno al siguiente', () => {
    const { state } = setupMatch({ hands: hands(), limit: 20 });
    const card = player(state, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');

    const { state: after, events } = act(state, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(types(events)).toEqual(['CardPlayed', 'CardDrawn', 'TurnStarted']);
    expect(after.pressure).toBe(2);
    expect(after.currentPlayer).toBe('beto');
    expect(after.turn).toBe(2);
    expect(player(after, 'ana').hand).toHaveLength(4);
    expect(player(after, 'ana').hand.some((c) => c.id === card.id)).toBe(false);
  });

  it('Enfriar baja la presión 3 sin pasar de 0', () => {
    const base = setupMatch({ hands: hands(), limit: 20 }).state;
    const coolCard = player(base, 'ana').hand[2];
    if (coolCard === undefined) throw new Error('sin carta');

    const fromFive = act({ ...base, pressure: 5 }, { type: 'play_card', playerId: 'ana', cardId: coolCard.id });
    expect(fromFive.state.pressure).toBe(2);
    const fromOne = act({ ...base, pressure: 1 }, { type: 'play_card', playerId: 'ana', cardId: coolCard.id });
    expect(fromOne.state.pressure).toBe(0);
  });

  it('el sismógrafo dice «cerca» si faltan 4 o menos y «lejos» si faltan más', () => {
    const base = setupMatch({ hands: hands(), limit: 20 }).state;
    const card = player(base, 'ana').hand[3];
    if (card === undefined) throw new Error('sin carta');

    const near = act({ ...base, pressure: 16 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(near.events).toContainEqual({ type: 'SeismoRead', playerId: 'ana', near: true });
    expect(near.state.pressure).toBe(16);

    const far = act({ ...base, pressure: 15 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(far.events).toContainEqual({ type: 'SeismoRead', playerId: 'ana', near: false });
  });

  it('pasar el límite provoca la erupción: pierde una vida, se revela el límite y empieza otra ronda', () => {
    const base = setupMatch({ hands: hands(), limit: 15 }).state;
    const card = player(base, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');

    const { state, events } = act({ ...base, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(types(events)).toEqual(['CardPlayed', 'Eruption', 'CardDrawn', 'RoundStarted', 'TurnStarted']);
    expect(player(state, 'ana').lives).toBe(2);
    expect(state.lastRevealedLimit).toBe(15);
    expect(state.round).toBe(2);
    expect(state.pressure).toBe(0);
    expect(state.currentPlayer).toBe('beto');
  });

  it('llegar justo al límite no provoca erupción', () => {
    const base = setupMatch({ hands: hands(), limit: 16 }).state;
    const card = player(base, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');
    const { events } = act({ ...base, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(types(events)).not.toContain('Eruption');
  });

  it('con 0 vidas el jugador queda eliminado, descarta su mano y se salta en los turnos', () => {
    const base = setupMatch({ hands: hands(), limit: 15, lives: { ana: 1 } }).state;
    const card = player(base, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');

    const { state, events } = act({ ...base, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(types(events)).toEqual(['CardPlayed', 'Eruption', 'PlayerEliminated', 'RoundStarted', 'TurnStarted']);
    expect(player(state, 'ana').eliminated).toBe(true);
    expect(player(state, 'ana').hand).toHaveLength(0);
    expect(state.currentPlayer).toBe('beto');

    const betoCard = player(state, 'beto').hand[1];
    if (betoCard === undefined) throw new Error('sin carta');
    const next = act(state, { type: 'play_card', playerId: 'beto', cardId: betoCard.id }).state;
    expect(next.currentPlayer).toBe('caro');
    const caroCard = player(next, 'caro').hand[1];
    if (caroCard === undefined) throw new Error('sin carta');
    expect(act(next, { type: 'play_card', playerId: 'caro', cardId: caroCard.id }).state.currentPlayer).toBe('beto');
  });

  it('gana el último que queda en pie', () => {
    const base = setupMatch({ hands: { ana: [stone(2)], beto: [stone(1)] }, limit: 15, lives: { ana: 1 } }).state;
    const card = player(base, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');
    const { state, events } = act({ ...base, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card.id });

    expect(events.at(-1)).toEqual({
      type: 'MatchEnded',
      result: { kind: 'winner', winner: 'beto', reason: 'last_standing' },
    });
    expect(state.status).toBe('finished');
    expect(state.currentPlayer).toBeNull();
  });

  it('al cerrar la última ronda gana quien tenga más vidas, o es empate', () => {
    const config = { maxRounds: 2 };
    const winBase = setupMatch({ hands: hands(), limit: 15, round: 2, config }).state;
    const card = player(winBase, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');
    const win = act({ ...winBase, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(win.state.result).toEqual({ kind: 'draw', players: ['beto', 'caro'], reason: 'tied_lives' });

    const leadBase = setupMatch({ hands: hands(), limit: 15, round: 2, config, lives: { caro: 2 } }).state;
    const card2 = player(leadBase, 'ana').hand[0];
    if (card2 === undefined) throw new Error('sin carta');
    const lead = act({ ...leadBase, pressure: 14 }, { type: 'play_card', playerId: 'ana', cardId: card2.id });
    expect(lead.state.result).toEqual({ kind: 'winner', winner: 'beto', reason: 'most_lives' });
  });

  it('rechaza jugar fuera de turno, una carta ajena, a alguien que no juega y una partida terminada', () => {
    const { state } = setupMatch({ hands: hands(), limit: 20 });
    const betoCard = player(state, 'beto').hand[0];
    if (betoCard === undefined) throw new Error('sin carta');

    expect(errorCode(state, { type: 'play_card', playerId: 'beto', cardId: betoCard.id })).toBe('NOT_YOUR_TURN');
    expect(errorCode(state, { type: 'play_card', playerId: 'ana', cardId: betoCard.id })).toBe('CARD_NOT_IN_HAND');
    expect(errorCode(state, { type: 'play_card', playerId: 'zoe', cardId: betoCard.id })).toBe('NOT_A_PLAYER');
    expect(errorCode({ ...state, status: 'finished' }, { type: 'play_card', playerId: 'ana', cardId: 'x' })).toBe(
      'MATCH_FINISHED',
    );
    expect(errorCode(createMatch('m', ['ana', 'beto']), { type: 'play_card', playerId: 'ana', cardId: 'x' })).toBe(
      'MATCH_NOT_STARTED',
    );
  });

  it('cuando se acaba el mazo, baraja el descarte y sigue robando', () => {
    const discard = [stone(1), stone(2), cool()];
    const { state } = setupMatch({ hands: hands(), limit: 20, drawPile: [], discard });
    const card = player(state, 'ana').hand[0];
    if (card === undefined) throw new Error('sin carta');

    const { state: after, events } = act(state, { type: 'play_card', playerId: 'ana', cardId: card.id });
    expect(types(events)).toEqual(['CardPlayed', 'DiscardReshuffled', 'CardDrawn', 'TurnStarted']);
    expect(player(after, 'ana').hand).toHaveLength(4);
    expect(after.drawPile.length + after.discard.length).toBe(discard.length + 1 - 1);
  });
});

describe('temporizador de turno', () => {
  it('juega la piedra de menor valor y la marca como automática', () => {
    const lowStone = stone(2);
    const { state } = setupMatch({
      hands: { ana: [cool(), stone(3), seismo(), lowStone], beto: [stone(1)] },
      limit: 20,
    });
    const { events } = act(state, { type: 'turn_timeout', playerId: 'ana', turn: 1 });
    expect(events[0]).toMatchObject({ type: 'CardPlayed', card: { id: lowStone.id }, auto: true });
  });

  it('sin piedras juega el sismógrafo antes que Enfriar', () => {
    const scope = seismo();
    const { state } = setupMatch({ hands: { ana: [cool(), scope, cool()], beto: [stone(1)] }, limit: 20 });
    const { events } = act(state, { type: 'turn_timeout', playerId: 'ana', turn: 1 });
    expect(events[0]).toMatchObject({ type: 'CardPlayed', card: { id: scope.id } });
  });

  it('ignora un temporizador de un turno que ya pasó', () => {
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(1)] }, limit: 20 });
    expect(errorCode(state, { type: 'turn_timeout', playerId: 'ana', turn: 0 })).toBe('STALE_TIMER');
    expect(errorCode(state, { type: 'turn_timeout', playerId: 'beto', turn: 1 })).toBe('STALE_TIMER');
  });
});

describe('abandono', () => {
  const hands = () => ({ ana: [stone(1), stone(2)], beto: [stone(1)], caro: [stone(1)] });

  it('si abandona quien tiene el turno, queda eliminado y el turno pasa al siguiente', () => {
    const { state } = setupMatch({ hands: hands(), limit: 20 });
    const { state: after } = act(state, { type: 'abandon', playerId: 'ana' });
    expect(player(after, 'ana')).toMatchObject({ eliminated: true, eliminationReason: 'abandon', hand: [] });
    expect(after.currentPlayer).toBe('beto');
    expect(after.discard).toHaveLength(2);
  });

  it('si abandona otro, el turno no cambia', () => {
    const { state } = setupMatch({ hands: hands(), limit: 20 });
    const { state: after, events } = act(state, { type: 'abandon', playerId: 'caro' });
    expect(types(events)).toEqual(['PlayerEliminated']);
    expect(after.currentPlayer).toBe('ana');
  });

  it('si queda uno solo, gana', () => {
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(1)] }, limit: 20 });
    expect(act(state, { type: 'abandon', playerId: 'beto' }).state.result).toEqual({
      kind: 'winner',
      winner: 'ana',
      reason: 'last_standing',
    });
  });

  it('rechaza abandonar dos veces', () => {
    const { state } = setupMatch({ hands: hands(), limit: 20 });
    const after = act(state, { type: 'abandon', playerId: 'caro' }).state;
    expect(errorCode(after, { type: 'abandon', playerId: 'caro' })).toBe('PLAYER_ELIMINATED');
  });
});

describe('terminar por administración', () => {
  it('cierra la partida sin ganador y nadie queda de turno', () => {
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(2)] }, limit: 20 });
    const { state: after, events } = act(state, { type: 'terminate' });
    expect(types(events)).toEqual(['MatchEnded']);
    expect(after.status).toBe('finished');
    expect(after.result).toEqual({ kind: 'aborted', reason: 'admin' });
    expect(after.currentPlayer).toBeNull();
  });

  it('después de terminarla ya no se puede jugar', () => {
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(2)] }, limit: 20 });
    const after = act(state, { type: 'terminate' }).state;
    const card = player(after, 'ana').hand[0];
    expect(errorCode(after, { type: 'play_card', playerId: 'ana', cardId: card?.id ?? '' })).toBe('MATCH_FINISHED');
  });

  it('rechaza terminar una partida que no empezó o que ya terminó', () => {
    expect(errorCode(createMatch('m', ['ana', 'beto']), { type: 'terminate' })).toBe('MATCH_NOT_STARTED');
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(1)] }, limit: 20 });
    const finished = act(state, { type: 'abandon', playerId: 'beto' }).state;
    expect(errorCode(finished, { type: 'terminate' })).toBe('MATCH_FINISHED');
  });
});

describe('pureza', () => {
  it('decide no modifica el estado y con la misma semilla produce los mismos eventos', () => {
    const initial = deepFreeze(createMatch('m1', ['ana', 'beto', 'caro']));
    const a = decide(initial, { type: 'start' }, { rng: seededRng(42) });
    const b = decide(initial, { type: 'start' }, { rng: seededRng(42) });
    expect(a).toEqual(b);

    if (!a.ok) throw new Error(a.error.message);
    const started = deepFreeze(replay(initial, a.value));
    const card = started.players.find((p) => p.id === started.currentPlayer)?.hand[0];
    if (card === undefined || started.currentPlayer === null) throw new Error('sin carta');
    expect(() =>
      decide(started, { type: 'play_card', playerId: started.currentPlayer ?? '', cardId: card.id }, { rng: minRng }),
    ).not.toThrow();
  });
});
