import {
  createMatch,
  decide,
  DEFAULT_CONFIG,
  DomainInvariantError,
  replay,
  type ArenalConfig,
  type DomainEvent,
  type GameState,
  type Intent,
  type MatchResult,
  type Rng,
  type RuleErrorCode,
} from '@arenal/domain';
import type { Clock } from '../clock.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION, withTransaction, type Db, type Tx } from '../db/tx.js';
import { conflict } from '../errors.js';
import { createGameMetrics, type GameMetrics } from '../observability/metrics.js';
import { attr, withSpan } from '../observability/tracing.js';
import { noopBus, type EventBus, type SequencedEvent } from '../realtime/bus.js';

export type MatchOrigin = 'room' | 'matchmaking';
export type MatchStatus = 'playing' | 'finished' | 'aborted';

export interface MatchRow {
  id: string;
  origin: MatchOrigin;
  status: MatchStatus;
  seq: number;
  config: ArenalConfig;
  player_ids: string[];
  current_player: string | null;
  turn: number;
  turn_timeout_ms: number;
  turn_deadline: Date | null;
  result: MatchResult | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export type { SequencedEvent };

export type ApplyRejection = RuleErrorCode | 'STALE_STATE' | 'MATCH_NOT_FOUND' | 'MOVE_ID_CONFLICT';

export type ApplyResult =
  | {
      readonly kind: 'applied';
      readonly seq: number;
      readonly events: readonly SequencedEvent[];
      readonly state: GameState;
    }
  | { readonly kind: 'duplicate'; readonly seq: number }
  | { readonly kind: 'rejected'; readonly code: ApplyRejection; readonly message: string; readonly seq: number | null };

export interface ApplyOptions {
  /** ID que genera el cliente para la jugada. Un reenvío con el mismo ID no se aplica dos veces. */
  readonly moveId?: string;
  /** Última secuencia que vio el cliente. Si la partida avanzó, la jugada se rechaza. */
  readonly expectedSeq?: number;
  /** Quién manda la jugada, para el registro de idempotencia. */
  readonly actorId?: string;
  /**
   * Trabajo extra dentro de la misma transacción, solo si la intención se aplicó (por ejemplo,
   * la fila de auditoría de una acción de administración). Si falla, la jugada tampoco queda.
   */
  readonly withinTransaction?: (tx: Tx, applied: { readonly seq: number; readonly state: GameState }) => Promise<void>;
}

export interface MatchStoreDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly config?: ArenalConfig;
  readonly turnTimeoutMs: number;
  /** Avisa a las demás réplicas de cada jugada confirmada. */
  readonly bus?: EventBus;
  readonly metrics?: GameMetrics;
}

/**
 * Persistencia de partidas. Postgres decide el orden: cada jugada corre en una transacción
 * que bloquea la fila de la partida (`FOR UPDATE`), así varias réplicas pueden recibir
 * jugadas de la misma partida y se procesan de a una, en orden.
 */
export class MatchStore {
  private readonly bus: EventBus;
  private readonly metrics: GameMetrics;

  constructor(private readonly deps: MatchStoreDeps) {
    this.bus = deps.bus ?? noopBus;
    this.metrics = deps.metrics ?? createGameMetrics();
  }

  /** Crea una partida dentro de la transacción del llamador (sala que arranca o cola). */
  async create(tx: Tx, origin: MatchOrigin, playerIds: readonly string[]): Promise<{ matchId: string; seq: number }> {
    const config = this.deps.config ?? DEFAULT_CONFIG;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO matches (origin, status, config, player_ids, turn_timeout_ms) VALUES ($1, 'playing', $2, $3, $4) RETURNING id`,
      [origin, JSON.stringify(config), playerIds, this.deps.turnTimeoutMs],
    );
    const matchId = rows[0]?.id;
    if (matchId === undefined) throw new Error('INSERT sin filas');

    try {
      // Hasta que se conecten cuentan como desconectados: quien nunca entra cae en abandono.
      await tx.query(
        `INSERT INTO match_players (match_id, user_id, disconnected_at) SELECT $1, unnest($2::uuid[]), $3::timestamptz`,
        [matchId, playerIds, this.deps.clock.now()],
      );
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw conflict('ALREADY_IN_MATCH', 'Un jugador ya está en otra partida activa');
      }
      throw error;
    }

    const initial = createMatch(matchId, playerIds, config);
    const started = decide(initial, { type: 'start' }, { rng: this.deps.rng });
    if (!started.ok) throw new DomainInvariantError(`No se pudo iniciar la partida: ${started.error.message}`);
    const state = replay(initial, started.value);
    await this.persist(tx, matchId, 0, initial.turn, started.value, state);
    return { matchId, seq: state.version };
  }

  /**
   * Aplica una intención: bloquea la partida, valida, guarda los eventos y actualiza el
   * resumen. Después de confirmar, avisa a las réplicas por el bus.
   */
  async apply(matchId: string, intent: Intent, options: ApplyOptions = {}): Promise<ApplyResult> {
    if (options.moveId !== undefined && options.actorId === undefined) {
      throw new Error('Una jugada con moveId necesita actorId');
    }
    const attributes = {
      [attr.matchId]: matchId,
      [attr.intent]: intent.type,
      ...('playerId' in intent && { [attr.playerId]: intent.playerId }),
    };
    return withSpan('match.apply', { attributes }, async (span) => {
      const started = performance.now();
      const result = await this.applyInTransaction(matchId, intent, options);
      if (result.kind === 'applied') await this.bus.matchEvents(matchId, result.events);
      const code = result.kind === 'rejected' ? result.code : undefined;
      span.setAttributes({
        [attr.outcome]: result.kind,
        ...(result.seq !== null && { [attr.seq]: result.seq }),
        ...(code !== undefined && { [attr.code]: code }),
      });
      this.metrics.intentProcessed(intent.type, result.kind, performance.now() - started, code);
      return result;
    });
  }

  private applyInTransaction(matchId: string, intent: Intent, options: ApplyOptions): Promise<ApplyResult> {
    return withTransaction(this.deps.db, async (tx) => {
      const row = await this.lockMatch(tx, matchId);
      if (row === undefined) {
        return { kind: 'rejected', code: 'MATCH_NOT_FOUND', message: 'La partida no existe', seq: null };
      }

      if (options.moveId !== undefined) {
        const previous = await tx.query<{ seq_after: number; user_id: string }>(
          'SELECT seq_after, user_id FROM match_moves WHERE match_id = $1 AND move_id = $2',
          [matchId, options.moveId],
        );
        const move = previous.rows[0];
        if (move !== undefined) {
          if (options.actorId !== undefined && move.user_id !== options.actorId) {
            return { kind: 'rejected', code: 'MOVE_ID_CONFLICT', message: 'Ese ID de jugada ya se usó', seq: row.seq };
          }
          return { kind: 'duplicate', seq: move.seq_after };
        }
      }

      if (options.expectedSeq !== undefined && options.expectedSeq !== row.seq) {
        return {
          kind: 'rejected',
          code: 'STALE_STATE',
          message: `La partida ya va en la secuencia ${row.seq}; la jugada se hizo sobre la ${options.expectedSeq}`,
          seq: row.seq,
        };
      }

      const state = await this.loadState(tx, row);
      const decision = decide(state, intent, { rng: this.deps.rng });
      if (!decision.ok) {
        return { kind: 'rejected', code: decision.error.code, message: decision.error.message, seq: row.seq };
      }

      const next = replay(state, decision.value);
      const events = await this.persist(tx, matchId, row.seq, state.turn, decision.value, next);
      if (options.moveId !== undefined) {
        await tx.query('INSERT INTO match_moves (match_id, move_id, user_id, seq_after) VALUES ($1, $2, $3, $4)', [
          matchId,
          options.moveId,
          options.actorId,
          next.version,
        ]);
      }
      await options.withinTransaction?.(tx, { seq: next.version, state: next });
      return { kind: 'applied', seq: next.version, events, state: next };
    });
  }

  /** Estado completo de la partida (con información oculta). Solo para uso del servidor. */
  async load(matchId: string): Promise<{ row: MatchRow; state: GameState } | undefined> {
    const { rows } = await this.deps.db.query<MatchRow>('SELECT * FROM matches WHERE id = $1', [matchId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return { row, state: await this.loadState(this.deps.db, row) };
  }

  async events(matchId: string): Promise<SequencedEvent[]> {
    return this.eventsBetween(matchId, 0, null);
  }

  /** Eventos con `afterSeq < seq <= upToSeq` (o hasta el final). Sirve para rellenar huecos. */
  async eventsBetween(matchId: string, afterSeq: number, upToSeq: number | null): Promise<SequencedEvent[]> {
    const { rows } = await this.deps.db.query<{ seq: number; event: DomainEvent }>(
      'SELECT seq, event FROM match_events WHERE match_id = $1 AND seq > $2 AND ($3::int IS NULL OR seq <= $3) ORDER BY seq',
      [matchId, afterSeq, upToSeq],
    );
    return rows;
  }

  private async lockMatch(tx: Tx, matchId: string): Promise<MatchRow | undefined> {
    const { rows } = await tx.query<MatchRow>('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
    return rows[0];
  }

  /**
   * Reconstruye el estado desde el inicio con todos los eventos. Es la versión simple a
   * propósito: la prueba de carga mide su costo antes de optimizarla.
   */
  private async loadState(db: Pick<Db, 'query'>, row: MatchRow): Promise<GameState> {
    const { rows } = await db.query<{ event: DomainEvent }>(
      'SELECT event FROM match_events WHERE match_id = $1 ORDER BY seq',
      [row.id],
    );
    const state = replay(
      createMatch(row.id, row.player_ids, row.config),
      rows.map((r) => r.event),
    );
    if (state.version !== row.seq) {
      throw new DomainInvariantError(`La partida ${row.id} tiene ${state.version} eventos pero seq ${row.seq}`);
    }
    return state;
  }

  private async persist(
    tx: Tx,
    matchId: string,
    fromSeq: number,
    previousTurn: number,
    events: readonly DomainEvent[],
    state: GameState,
  ): Promise<SequencedEvent[]> {
    const sequenced = events.map((event, i) => ({ seq: fromSeq + i + 1, event }));
    if (sequenced.length > 0) {
      await tx.query(
        `INSERT INTO match_events (match_id, seq, event)
         SELECT $1, s, e FROM unnest($2::int[], $3::jsonb[]) AS t(s, e)`,
        [matchId, sequenced.map((e) => e.seq), sequenced.map((e) => JSON.stringify(e.event))],
      );
    }

    const now = this.deps.clock.now();
    const finished = state.status === 'finished';
    const status: MatchStatus = !finished ? 'playing' : state.result?.kind === 'aborted' ? 'aborted' : 'finished';
    const turnChanged = state.turn !== previousTurn;
    await tx.query(
      `UPDATE matches SET
         seq = $2,
         status = $3,
         current_player = $4,
         turn = $5,
         turn_deadline = CASE WHEN $3 <> 'playing' THEN NULL WHEN $6 THEN $7::timestamptz ELSE turn_deadline END,
         result = $8,
         finished_at = CASE WHEN $3 <> 'playing' THEN $9::timestamptz ELSE finished_at END,
         updated_at = $9
       WHERE id = $1`,
      [
        matchId,
        state.version,
        status,
        state.currentPlayer,
        state.turn,
        turnChanged,
        new Date(now.getTime() + this.deps.turnTimeoutMs),
        state.result === null ? null : JSON.stringify(state.result),
        now,
      ],
    );

    const freed = finished
      ? state.players.map((p) => p.id)
      : events.flatMap((e) => (e.type === 'PlayerEliminated' ? [e.playerId] : []));
    if (freed.length > 0) {
      await tx.query('UPDATE match_players SET active = false WHERE match_id = $1 AND user_id = ANY($2::uuid[])', [
        matchId,
        freed,
      ]);
    }
    return sequenced;
  }
}
