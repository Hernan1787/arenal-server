import { buildShuffledDeck, defaultCard } from './cards.js';
import { validateConfig } from './config.js';
import type { DomainEvent } from './events.js';
import { evolve } from './evolve.js';
import type { Intent } from './intents.js';
import { shuffle, type Rng } from './rng.js';
import { alivePlayers, findPlayer, nextAlivePlayer, type GameState, type MatchResult } from './state.js';
import { fail, ok, type Card, type PlayerId, type Result } from './types.js';

export interface DecideContext {
  readonly rng: Rng;
}

/**
 * Valida una intención contra las reglas y el estado actual, y devuelve los eventos que
 * produce. No modifica el estado: el llamador guarda los eventos y los aplica con `evolve`.
 */
export function decide(state: GameState, intent: Intent, ctx: DecideContext): Result<DomainEvent[]> {
  switch (intent.type) {
    case 'start':
      return start(state, ctx);
    case 'play_card':
      return playCard(state, intent.playerId, intent.cardId, false, ctx);
    case 'turn_timeout':
      return turnTimeout(state, intent.playerId, intent.turn, ctx);
    case 'abandon':
      return abandon(state, intent.playerId);
  }
}

/** Acumula eventos y mantiene el estado al día, para que cada decisión vea el efecto de la anterior. */
class Recorder {
  readonly events: DomainEvent[] = [];
  constructor(public state: GameState) {}

  emit(event: DomainEvent): void {
    this.events.push(event);
    this.state = evolve(this.state, event);
  }
}

function start(state: GameState, ctx: DecideContext): Result<DomainEvent[]> {
  if (state.status !== 'waiting') return fail('ALREADY_STARTED', 'La partida ya empezó');
  const problems = validateConfig(state.config);
  if (problems.length > 0) return fail('INVALID_CONFIG', problems.join('; '));

  const ids = state.players.map((p) => p.id);
  if (new Set(ids).size !== ids.length) return fail('DUPLICATE_PLAYER', 'Un jugador aparece dos veces');
  if (ids.length < state.config.minPlayers) {
    return fail('NOT_ENOUGH_PLAYERS', `Se necesitan al menos ${state.config.minPlayers} jugadores`);
  }
  if (ids.length > state.config.maxPlayers) {
    return fail('TOO_MANY_PLAYERS', `El máximo es ${state.config.maxPlayers} jugadores`);
  }

  const rec = new Recorder(state);
  const playerOrder = shuffle(ids, ctx.rng);
  rec.emit({ type: 'MatchStarted', playerOrder });
  rec.emit({ type: 'DeckShuffled', cards: buildShuffledDeck(state.config, ctx.rng) });

  for (let i = 0; i < state.config.handSize; i++) {
    for (const playerId of playerOrder) drawCard(rec, playerId, ctx);
  }

  const first = playerOrder[0];
  if (first === undefined) return fail('NOT_ENOUGH_PLAYERS', 'No hay jugadores');
  startRound(rec, first, ctx);
  return ok(rec.events);
}

function guardTurn(state: GameState, playerId: PlayerId): Result<null> {
  if (state.status === 'waiting') return fail('MATCH_NOT_STARTED', 'La partida no ha empezado');
  if (state.status === 'finished') return fail('MATCH_FINISHED', 'La partida ya terminó');
  const player = findPlayer(state, playerId);
  if (player === undefined) return fail('NOT_A_PLAYER', 'No participas en esta partida');
  if (player.eliminated) return fail('PLAYER_ELIMINATED', 'Ya fuiste eliminado de esta partida');
  if (state.currentPlayer !== playerId) return fail('NOT_YOUR_TURN', 'No es tu turno');
  return ok(null);
}

function playCard(
  state: GameState,
  playerId: PlayerId,
  cardId: string,
  auto: boolean,
  ctx: DecideContext,
): Result<DomainEvent[]> {
  const guard = guardTurn(state, playerId);
  if (!guard.ok) return fail(guard.error.code, guard.error.message);

  const player = findPlayer(state, playerId);
  const card = player?.hand.find((c) => c.id === cardId);
  if (card === undefined) return fail('CARD_NOT_IN_HAND', 'Esa carta no está en tu mano');
  if (state.limit === null) return fail('MATCH_NOT_STARTED', 'No hay una ronda en curso');

  const limit = state.limit;
  const rec = new Recorder(state);
  const pressureAfter = pressureAfterPlaying(state.pressure, card, state.config.coolAmount);
  rec.emit({ type: 'CardPlayed', playerId, card, pressureAfter, auto });

  if (card.kind === 'seismo') {
    rec.emit({ type: 'SeismoRead', playerId, near: limit - pressureAfter <= state.config.seismoThreshold });
  }

  const erupted = pressureAfter > limit;
  if (erupted) {
    const livesLeft = (findPlayer(rec.state, playerId)?.lives ?? 1) - 1;
    rec.emit({ type: 'Eruption', playerId, limit, livesLeft });
    if (livesLeft <= 0) eliminate(rec, playerId, 'lives');
  }

  if (findPlayer(rec.state, playerId)?.eliminated === false) drawCard(rec, playerId, ctx);

  if (endIfOneLeft(rec)) return ok(rec.events);

  if (erupted) {
    if (rec.state.round >= state.config.maxRounds) {
      rec.emit({ type: 'MatchEnded', result: resultByLives(rec.state) });
    } else {
      const first = nextAlivePlayer(rec.state, playerId);
      if (first !== null) startRound(rec, first, ctx);
    }
  } else {
    const next = nextAlivePlayer(rec.state, playerId);
    if (next !== null) rec.emit({ type: 'TurnStarted', playerId: next, turn: rec.state.turn + 1 });
  }
  return ok(rec.events);
}

function turnTimeout(state: GameState, playerId: PlayerId, turn: number, ctx: DecideContext): Result<DomainEvent[]> {
  if (state.status !== 'playing' || state.turn !== turn || state.currentPlayer !== playerId) {
    return fail('STALE_TIMER', 'El temporizador corresponde a un turno que ya pasó');
  }
  const card = defaultCard(findPlayer(state, playerId)?.hand ?? []);
  if (card === undefined) return abandon(state, playerId);
  return playCard(state, playerId, card.id, true, ctx);
}

function abandon(state: GameState, playerId: PlayerId): Result<DomainEvent[]> {
  if (state.status === 'waiting') return fail('MATCH_NOT_STARTED', 'La partida no ha empezado');
  if (state.status === 'finished') return fail('MATCH_FINISHED', 'La partida ya terminó');
  const player = findPlayer(state, playerId);
  if (player === undefined) return fail('NOT_A_PLAYER', 'No participas en esta partida');
  if (player.eliminated) return fail('PLAYER_ELIMINATED', 'Ya fuiste eliminado de esta partida');

  const rec = new Recorder(state);
  const hadTurn = state.currentPlayer === playerId;
  eliminate(rec, playerId, 'abandon');
  if (endIfOneLeft(rec)) return ok(rec.events);

  if (hadTurn) {
    const next = nextAlivePlayer(rec.state, playerId);
    if (next !== null) rec.emit({ type: 'TurnStarted', playerId: next, turn: rec.state.turn + 1 });
  }
  return ok(rec.events);
}

function pressureAfterPlaying(pressure: number, card: Card, coolAmount: number): number {
  switch (card.kind) {
    case 'stone':
      return pressure + card.value;
    case 'cool':
      return Math.max(0, pressure - coolAmount);
    case 'seismo':
      return pressure;
  }
}

function drawCard(rec: Recorder, playerId: PlayerId, ctx: DecideContext): void {
  if (rec.state.drawPile.length === 0 && rec.state.discard.length > 0) {
    rec.emit({ type: 'DiscardReshuffled', cards: shuffle(rec.state.discard, ctx.rng) });
  }
  const top = rec.state.drawPile[0];
  if (top !== undefined) rec.emit({ type: 'CardDrawn', playerId, card: top });
}

function startRound(rec: Recorder, firstPlayer: PlayerId, ctx: DecideContext): void {
  const { limitMin, limitMax } = rec.state.config;
  rec.emit({ type: 'RoundStarted', round: rec.state.round + 1, limit: ctx.rng.int(limitMin, limitMax), firstPlayer });
  rec.emit({ type: 'TurnStarted', playerId: firstPlayer, turn: rec.state.turn + 1 });
}

function eliminate(rec: Recorder, playerId: PlayerId, reason: 'lives' | 'abandon'): void {
  const discarded = findPlayer(rec.state, playerId)?.hand ?? [];
  rec.emit({ type: 'PlayerEliminated', playerId, reason, discarded });
}

/** Si queda un jugador o ninguno, emite el fin de la partida y devuelve `true`. */
function endIfOneLeft(rec: Recorder): boolean {
  const alive = alivePlayers(rec.state);
  if (alive.length > 1) return false;
  const [last] = alive;
  const result: MatchResult =
    last === undefined
      ? { kind: 'draw', players: [], reason: 'no_players' }
      : { kind: 'winner', winner: last.id, reason: 'last_standing' };
  rec.emit({ type: 'MatchEnded', result });
  return true;
}

function resultByLives(state: GameState): MatchResult {
  const alive = alivePlayers(state);
  const best = Math.max(...alive.map((p) => p.lives));
  const leaders = alive.filter((p) => p.lives === best).map((p) => p.id);
  const [only] = leaders;
  return leaders.length === 1 && only !== undefined
    ? { kind: 'winner', winner: only, reason: 'most_lives' }
    : { kind: 'draw', players: leaders, reason: 'tied_lives' };
}
