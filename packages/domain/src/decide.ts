import { buildShuffledDeck, defaultPlay } from './cards.js';
import { validateConfig, type ArenalConfig } from './config.js';
import type { DomainEvent } from './events.js';
import { evolve } from './evolve.js';
import type { Intent } from './intents.js';
import { shuffle, type Rng } from './rng.js';
import { alivePlayers, findPlayer, nextAlivePlayer, type GameState, type MatchResult } from './state.js';
import { fail, needsTarget, ok, type Card, type PlayerId, type Result } from './types.js';

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
      return playCard(state, intent.playerId, intent.cardId, intent.targetId, false, ctx);
    case 'turn_timeout':
      return turnTimeout(state, intent.playerId, intent.turn, ctx);
    case 'abandon':
      return abandon(state, intent.playerId);
    case 'terminate':
      return terminate(state);
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
  targetId: PlayerId | undefined,
  auto: boolean,
  ctx: DecideContext,
): Result<DomainEvent[]> {
  const guard = guardTurn(state, playerId);
  if (!guard.ok) return fail(guard.error.code, guard.error.message);

  const player = findPlayer(state, playerId);
  const card = player?.hand.find((c) => c.id === cardId);
  if (player === undefined || card === undefined) return fail('CARD_NOT_IN_HAND', 'Esa carta no está en tu mano');
  if (state.limit === null) return fail('MATCH_NOT_STARTED', 'No hay una ronda en curso');

  const target = targetId === undefined ? undefined : findPlayer(state, targetId);
  if (needsTarget(card)) {
    if (targetId === undefined) return fail('TARGET_REQUIRED', 'Esa carta se juega contra un rival: elige a quién');
    if (target === undefined || target.id === playerId || target.eliminated || target.hand.length === 0) {
      return fail('INVALID_TARGET', 'Ese jugador no puede ser el objetivo');
    }
  } else if (targetId !== undefined) {
    return fail('INVALID_TARGET', 'Esa carta no se juega contra nadie');
  }
  if (card.kind === 'shield' && player.shielded) return fail('SHIELD_ACTIVE', 'Ya tienes un escudo puesto');

  const limit = state.limit;
  const rec = new Recorder(state);
  const rolled = card.kind === 'quake' ? ctx.rng.int(state.config.quakeMin, state.config.quakeMax) : undefined;
  const pressureAfter = pressureAfterPlaying(state.pressure, card, state.config, rolled ?? 0);
  rec.emit({
    type: 'CardPlayed',
    playerId,
    card,
    pressureAfter,
    auto,
    ...(target !== undefined && { targetId: target.id }),
    ...(rolled !== undefined && { rolled }),
  });

  if (card.kind === 'seismo') {
    rec.emit({ type: 'SeismoRead', playerId, near: limit - pressureAfter <= state.config.seismoThreshold });
  }
  if ((card.kind === 'ash' || card.kind === 'steal') && target !== undefined) {
    // La carta la sortea el servidor: quien juega no elige cuál ve ni cuál se lleva.
    const pick = target.hand[ctx.rng.int(0, target.hand.length - 1)];
    if (pick !== undefined) {
      if (card.kind === 'ash') {
        rec.emit({ type: 'CardPeeked', playerId, targetId: target.id, card: pick });
      } else {
        rec.emit({ type: 'CardStolen', playerId, targetId: target.id, card: pick });
        // La víctima repone del mazo; el ladrón no roba, porque ya se quedó con una carta.
        drawCard(rec, target.id, ctx);
      }
    }
  }

  const erupted = pressureAfter > limit;
  if (erupted) {
    const before = findPlayer(rec.state, playerId);
    const shielded = before?.shielded === true;
    const livesLeft = (before?.lives ?? 1) - (shielded ? 0 : 1);
    rec.emit({ type: 'Eruption', playerId, limit, livesLeft, shielded });
    if (livesLeft <= 0) eliminate(rec, playerId, 'lives');
  }

  if (findPlayer(rec.state, playerId)?.eliminated === false && card.kind !== 'steal') drawCard(rec, playerId, ctx);

  if (endIfOneLeft(rec)) return ok(rec.events);

  if (erupted) {
    if (rec.state.round >= state.config.maxRounds) {
      rec.emit({ type: 'MatchEnded', result: resultByLives(rec.state) });
    } else {
      const first = nextAlivePlayer(rec.state, playerId);
      if (first !== null) startRound(rec, first, ctx);
    }
  } else if (card.kind === 'divert') {
    // Desvío corta el turno (aunque debiera otra carta) y le pasa dos jugadas al siguiente.
    const next = nextAlivePlayer(rec.state, playerId);
    if (next !== null) rec.emit({ type: 'TurnStarted', playerId: next, turn: rec.state.turn + 1, playsLeft: 2 });
  } else if (rec.state.playsLeft > 1) {
    // Segunda carta del Desvío: es otro turno, con su propio temporizador.
    rec.emit({ type: 'TurnStarted', playerId, turn: rec.state.turn + 1, playsLeft: rec.state.playsLeft - 1 });
  } else {
    const next = nextAlivePlayer(rec.state, playerId);
    if (next !== null) rec.emit({ type: 'TurnStarted', playerId: next, turn: rec.state.turn + 1, playsLeft: 1 });
  }
  return ok(rec.events);
}

function turnTimeout(state: GameState, playerId: PlayerId, turn: number, ctx: DecideContext): Result<DomainEvent[]> {
  if (state.status !== 'playing' || state.turn !== turn || state.currentPlayer !== playerId) {
    return fail('STALE_TIMER', 'El temporizador corresponde a un turno que ya pasó');
  }
  const play = defaultPlay(state, playerId);
  if (play === undefined) return abandon(state, playerId);
  return playCard(state, playerId, play.cardId, play.targetId, true, ctx);
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
    if (next !== null) rec.emit({ type: 'TurnStarted', playerId: next, turn: rec.state.turn + 1, playsLeft: 1 });
  }
  return ok(rec.events);
}

/** Un administrador termina la partida: se cierra sin ganador y la mano de nadie se revela. */
function terminate(state: GameState): Result<DomainEvent[]> {
  if (state.status === 'waiting') return fail('MATCH_NOT_STARTED', 'La partida no ha empezado');
  if (state.status === 'finished') return fail('MATCH_FINISHED', 'La partida ya terminó');
  return ok([{ type: 'MatchEnded', result: { kind: 'aborted', reason: 'admin' } }]);
}

function pressureAfterPlaying(pressure: number, card: Card, config: ArenalConfig, rolled: number): number {
  switch (card.kind) {
    case 'stone':
      return pressure + card.value;
    case 'bomb':
      return pressure + config.bombAmount;
    case 'quake':
      return pressure + rolled;
    case 'cool':
      return Math.max(0, pressure - config.coolAmount);
    case 'rain':
      return Math.max(0, pressure - config.rainAmount);
    case 'seismo':
    case 'divert':
    case 'ash':
    case 'steal':
    case 'shield':
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
  rec.emit({ type: 'TurnStarted', playerId: firstPlayer, turn: rec.state.turn + 1, playsLeft: 1 });
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
