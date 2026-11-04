import { describe, expect, it } from 'vitest';
import {
  completeConfig,
  DEFAULT_CONFIG,
  defaultPlay,
  evolve,
  projectEvent,
  replay,
  viewFor,
  type DomainEvent,
  type GameState,
  type Rng,
} from '../src/index.js';
import { act, errorCode, player, setupMatch, special, stone } from './support.js';

const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.type);
const fixed = (n: number): Rng => ({ int: (min, max) => Math.min(max, Math.max(min, n)) });

describe('Bomba y Lluvia', () => {
  it('la Bomba sube la presión 5 y puede provocar la erupción', () => {
    const bomb = special('bomb');
    const { state } = setupMatch({ hands: { ana: [bomb, stone(1)], beto: [stone(1)] }, limit: 20 });
    expect(
      act({ ...state, pressure: 10 }, { type: 'play_card', playerId: 'ana', cardId: bomb.id }).state.pressure,
    ).toBe(15);
    const boom = act({ ...state, pressure: 16 }, { type: 'play_card', playerId: 'ana', cardId: bomb.id });
    expect(types(boom.events)).toContain('Eruption');
  });

  it('la Lluvia baja la presión 5 sin pasar de 0', () => {
    const rain = special('rain');
    const { state } = setupMatch({ hands: { ana: [rain], beto: [stone(1)] }, limit: 20 });
    expect(
      act({ ...state, pressure: 12 }, { type: 'play_card', playerId: 'ana', cardId: rain.id }).state.pressure,
    ).toBe(7);
    expect(act({ ...state, pressure: 3 }, { type: 'play_card', playerId: 'ana', cardId: rain.id }).state.pressure).toBe(
      0,
    );
  });
});

describe('Temblor', () => {
  it('sube lo que sortea el servidor, el número queda en el evento y repetir la partida no vuelve a sortear', () => {
    const quake = special('quake');
    const { state } = setupMatch({ hands: { ana: [quake], beto: [stone(1)] }, limit: 20 });
    const before = { ...state, pressure: 10 };
    const { state: after, events } = act(before, { type: 'play_card', playerId: 'ana', cardId: quake.id }, fixed(3));
    const played = events.find((e) => e.type === 'CardPlayed');
    expect(played).toMatchObject({ rolled: 3, pressureAfter: 13 });
    expect(after.pressure).toBe(13);
    expect(replay(before, events)).toEqual(after);
  });

  it('sortea siempre dentro del rango configurado', () => {
    const quake = special('quake');
    const { state } = setupMatch({ hands: { ana: [quake], beto: [stone(1)] }, limit: 25 });
    for (const roll of [0, 1, 4, 9]) {
      const played = act(state, { type: 'play_card', playerId: 'ana', cardId: quake.id }, fixed(roll)).events.find(
        (e) => e.type === 'CardPlayed',
      );
      const rolled = played?.type === 'CardPlayed' ? played.rolled : undefined;
      expect(rolled).toBeGreaterThanOrEqual(DEFAULT_CONFIG.quakeMin);
      expect(rolled).toBeLessThanOrEqual(DEFAULT_CONFIG.quakeMax);
    }
  });
});

describe('Desvío', () => {
  const setup = () => {
    const divert = special('divert');
    const b1 = stone(1);
    const b2 = stone(2);
    const { state } = setupMatch({
      hands: { ana: [divert, stone(1)], beto: [b1, b2, special('divert')], caro: [stone(1)] },
      limit: 20,
    });
    return { state, divert, b1, b2 };
  };

  it('no cambia la presión y el siguiente juega dos cartas, cada una con su propio turno', () => {
    const { state, divert, b1, b2 } = setup();
    const diverted = act({ ...state, pressure: 7 }, { type: 'play_card', playerId: 'ana', cardId: divert.id }).state;
    expect(diverted.pressure).toBe(7);
    expect(diverted.currentPlayer).toBe('beto');
    expect(diverted.playsLeft).toBe(2);
    expect(viewFor(diverted, 'caro').playsLeft).toBe(2);

    const firstTurn = diverted.turn;
    const first = act(diverted, { type: 'play_card', playerId: 'beto', cardId: b1.id }).state;
    expect(first.currentPlayer).toBe('beto');
    expect(first.playsLeft).toBe(1);
    expect(first.turn).toBe(firstTurn + 1);
    // El temporizador del primer turno ya no sirve: el segundo tiene el suyo.
    expect(errorCode(first, { type: 'turn_timeout', playerId: 'beto', turn: firstTurn })).toBe('STALE_TIMER');

    const second = act(first, { type: 'play_card', playerId: 'beto', cardId: b2.id }).state;
    expect(second.currentPlayer).toBe('caro');
    expect(second.playsLeft).toBe(1);
  });

  it('jugar Desvío durante un Desvío corta el turno y le pasa las dos cartas al siguiente', () => {
    const { state, divert } = setup();
    const diverted = act(state, { type: 'play_card', playerId: 'ana', cardId: divert.id }).state;
    const betoDivert = player(diverted, 'beto').hand.find((c) => c.kind === 'divert');
    const back = act(diverted, { type: 'play_card', playerId: 'beto', cardId: betoDivert?.id ?? '' }).state;
    expect(back.currentPlayer).toBe('caro');
    expect(back.playsLeft).toBe(2);
  });

  it('si la primera carta provoca la erupción, la ronda nueva empieza normal con el siguiente', () => {
    const { state, divert, b2 } = setup();
    const diverted = act({ ...state, pressure: 19 }, { type: 'play_card', playerId: 'ana', cardId: divert.id }).state;
    const boom = act(diverted, { type: 'play_card', playerId: 'beto', cardId: b2.id });
    expect(types(boom.events)).toContain('Eruption');
    expect(boom.state.currentPlayer).toBe('caro');
    expect(boom.state.playsLeft).toBe(1);
  });

  it('si vence el turno, el servidor juega una carta y la segunda sigue pendiente', () => {
    const { state, divert } = setup();
    const diverted = act(state, { type: 'play_card', playerId: 'ana', cardId: divert.id }).state;
    const timedOut = act(diverted, { type: 'turn_timeout', playerId: 'beto', turn: diverted.turn }).state;
    expect(timedOut.currentPlayer).toBe('beto');
    expect(timedOut.playsLeft).toBe(1);
  });
});

describe('Ceniza', () => {
  const setup = () => {
    const ash = special('ash');
    const seen = stone(4);
    const { state } = setupMatch({ hands: { ana: [ash, stone(1)], beto: [seen], caro: [stone(2)] }, limit: 20 });
    return { state, ash, seen };
  };

  it('pide un rival válido', () => {
    const { state, ash } = setup();
    const play = { type: 'play_card', playerId: 'ana', cardId: ash.id } as const;
    expect(errorCode(state, play)).toBe('TARGET_REQUIRED');
    expect(errorCode(state, { ...play, targetId: 'ana' })).toBe('INVALID_TARGET');
    expect(errorCode(state, { ...play, targetId: 'zoe' })).toBe('INVALID_TARGET');
    const out = { ...state, players: state.players.map((p) => (p.id === 'beto' ? { ...p, eliminated: true } : p)) };
    expect(errorCode(out, { ...play, targetId: 'beto' })).toBe('INVALID_TARGET');
  });

  it('una carta que no va contra nadie no acepta rival', () => {
    const { state } = setup();
    const card = player(state, 'ana').hand.find((c) => c.kind === 'stone');
    expect(errorCode(state, { type: 'play_card', playerId: 'ana', cardId: card?.id ?? '', targetId: 'beto' })).toBe(
      'INVALID_TARGET',
    );
  });

  it('solo quien mira sabe qué carta vio, sin su ID; la víctima sabe qué le vieron y los demás solo que miró', () => {
    const { state, ash, seen } = setup();
    const { state: after, events } = act(state, {
      type: 'play_card',
      playerId: 'ana',
      cardId: ash.id,
      targetId: 'beto',
    });
    const peek = events.find((e) => e.type === 'CardPeeked');
    expect(peek).toMatchObject({ playerId: 'ana', targetId: 'beto', card: { id: seen.id } });
    if (peek === undefined) throw new Error('falta el evento');

    expect(viewFor(after, 'ana').you?.peek).toEqual({ targetId: 'beto', card: { kind: 'stone', value: 4 } });
    expect(JSON.stringify(viewFor(after, 'ana'))).not.toContain(seen.id);
    expect(viewFor(after, 'beto').you?.peek).toBeNull();

    expect(projectEvent(peek, 'ana')).toEqual({ ...peek, card: { kind: 'stone', value: 4 } });
    expect(projectEvent(peek, 'beto')).toEqual({ ...peek, card: { kind: 'stone', value: 4 } });
    expect(projectEvent(peek, 'caro')).toEqual({ type: 'CardPeeked', playerId: 'ana', targetId: 'beto' });
    expect(projectEvent(peek, null)).not.toHaveProperty('card');
  });

  it('lo que se vio dura la ronda', () => {
    const { state, ash } = setup();
    const after = act(state, { type: 'play_card', playerId: 'ana', cardId: ash.id, targetId: 'beto' }).state;
    const nextRound = evolve(after, { type: 'RoundStarted', round: 2, limit: 18, firstPlayer: 'beto' });
    expect(viewFor(nextRound, 'ana').you?.peek).toBeNull();
  });
});

describe('Robo', () => {
  it('la carta pasa al ladrón, la víctima repone del mazo y nadie más sabe qué carta fue', () => {
    const steal = special('steal');
    const loot = special('rain');
    const refill = stone(3);
    const { state } = setupMatch({
      hands: {
        ana: [steal, stone(1), stone(1), stone(1)],
        beto: [loot, stone(2), stone(2), stone(2)],
        caro: [stone(1)],
      },
      drawPile: [refill, stone(1), stone(1)],
      limit: 20,
    });
    // El azar mínimo elige la primera carta de la víctima.
    const { state: after, events } = act(state, {
      type: 'play_card',
      playerId: 'ana',
      cardId: steal.id,
      targetId: 'beto',
    });
    expect(types(events)).toEqual(['CardPlayed', 'CardStolen', 'CardDrawn', 'TurnStarted']);
    expect(player(after, 'ana').hand.map((c) => c.id)).toContain(loot.id);
    expect(player(after, 'beto').hand.map((c) => c.id)).toContain(refill.id);
    expect(player(after, 'beto').hand.map((c) => c.id)).not.toContain(loot.id);
    // El ladrón no roba del mazo: los dos siguen con 4 cartas.
    expect([player(after, 'ana').hand.length, player(after, 'beto').hand.length]).toEqual([4, 4]);

    const stolen = events.find((e) => e.type === 'CardStolen');
    if (stolen === undefined) throw new Error('falta el evento');
    expect(projectEvent(stolen, 'ana')).toHaveProperty('card.id', loot.id);
    expect(projectEvent(stolen, 'beto')).toHaveProperty('card.id', loot.id);
    expect(projectEvent(stolen, 'caro')).not.toHaveProperty('card');
  });

  it('se usa el azar del servidor para elegir la carta', () => {
    const steal = special('steal');
    const last = stone(4);
    const { state } = setupMatch({
      hands: { ana: [steal], beto: [stone(1), stone(2), last], caro: [stone(1)] },
      limit: 20,
    });
    const { state: after } = act(
      state,
      { type: 'play_card', playerId: 'ana', cardId: steal.id, targetId: 'beto' },
      fixed(2),
    );
    expect(player(after, 'ana').hand.map((c) => c.id)).toEqual([last.id]);
  });
});

describe('Escudo', () => {
  const setup = () => {
    const shield = special('shield');
    const spare = special('shield');
    const big = stone(4);
    const { state } = setupMatch({ hands: { ana: [shield, spare, big, stone(4)], beto: [stone(1)] }, limit: 20 });
    return { state, shield, spare, big };
  };

  it('se juega a la vista de todos y no se puede tener dos', () => {
    const { state, shield, spare } = setup();
    const after = act(state, { type: 'play_card', playerId: 'ana', cardId: shield.id }).state;
    expect(player(after, 'ana').shielded).toBe(true);
    expect(viewFor(after, 'beto').players.find((p) => p.id === 'ana')?.shielded).toBe(true);
    const anaAgain = { ...after, currentPlayer: 'ana' };
    expect(errorCode(anaAgain, { type: 'play_card', playerId: 'ana', cardId: spare.id })).toBe('SHIELD_ACTIVE');
  });

  it('aguanta una erupción y se gasta; la siguiente sí cuesta vida', () => {
    const { state, shield, big } = setup();
    const shielded = act(state, { type: 'play_card', playerId: 'ana', cardId: shield.id }).state;
    const anaTurn: GameState = { ...shielded, currentPlayer: 'ana', pressure: 18 };
    const first = act(anaTurn, { type: 'play_card', playerId: 'ana', cardId: big.id });
    expect(first.events.find((e) => e.type === 'Eruption')).toMatchObject({ livesLeft: 2, shielded: true });
    expect(player(first.state, 'ana')).toMatchObject({ lives: 2, shielded: false });

    const again = player(first.state, 'ana').hand.find((c) => c.kind === 'stone' && c.value === 4);
    const anaAgain: GameState = { ...first.state, currentPlayer: 'ana', pressure: 20, limit: 20 };
    const second = act(anaAgain, { type: 'play_card', playerId: 'ana', cardId: again?.id ?? '' });
    expect(second.events.find((e) => e.type === 'Eruption')).toMatchObject({ livesLeft: 1, shielded: false });
  });
});

describe('jugada automática', () => {
  it('no juega un Escudo si ya hay uno, y apunta sola si solo quedan cartas contra rivales', () => {
    const ash = special('ash');
    const shield = special('shield');
    const { state } = setupMatch({ hands: { ana: [shield, ash], beto: [stone(1)], caro: [stone(1)] }, limit: 20 });
    const covered: GameState = {
      ...state,
      players: state.players.map((p) => (p.id === 'ana' ? { ...p, shielded: true } : p)),
    };
    expect(defaultPlay(covered, 'ana')).toEqual({ cardId: ash.id, targetId: 'beto' });
    expect(defaultPlay(state, 'ana')).toEqual({ cardId: shield.id });
    const timedOut = act(covered, { type: 'turn_timeout', playerId: 'ana', turn: covered.turn }).events;
    expect(timedOut.find((e) => e.type === 'CardPlayed')).toMatchObject({ auto: true, targetId: 'beto' });
  });

  it('prefiere la piedra más baja', () => {
    const low = stone(1);
    const { state } = setupMatch({
      hands: { ana: [special('bomb'), stone(3), low, special('steal')], beto: [stone(1)] },
      limit: 20,
    });
    expect(defaultPlay(state, 'ana')).toEqual({ cardId: low.id });
  });
});

describe('partidas guardadas antes de las cartas nuevas', () => {
  it('su configuración se completa con las reglas nuevas y un mazo sin las cartas nuevas', () => {
    // Así guardaba la configuración la versión 1 del juego (columna `config` de la partida).
    const stored = {
      minPlayers: 2,
      maxPlayers: 5,
      startingLives: 3,
      handSize: 4,
      limitMin: 15,
      limitMax: 25,
      coolAmount: 3,
      seismoThreshold: 4,
      maxRounds: 15,
      deck: { stones: { 1: 10, 2: 10, 3: 8, 4: 6 }, cool: 6, seismo: 4 },
    };
    const config = completeConfig(stored);
    expect(config.rainAmount).toBe(5);
    expect(config.deck).toMatchObject({ cool: 6, bomb: 0, steal: 0, shield: 0 });
  });

  it('un turno viejo sin `playsLeft` es de una carta y una erupción vieja no toca el escudo', () => {
    const { state } = setupMatch({ hands: { ana: [stone(1)], beto: [stone(1)] }, limit: 20 });
    const turn = evolve(state, { type: 'TurnStarted', playerId: 'beto', turn: 9 });
    expect(turn.playsLeft).toBe(1);
    const covered = { ...state, players: state.players.map((p) => ({ ...p, shielded: true })) };
    const old = evolve(covered, { type: 'Eruption', playerId: 'ana', limit: 20, livesLeft: 2 });
    expect(player(old, 'ana')).toMatchObject({ lives: 2, shielded: true });
  });
});
