import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db } from '../db/tx.js';
import type { MatchStore } from '../matches/match-store.js';
import type { Presence } from './presence.js';

export interface SweepResult {
  readonly turnTimeouts: number;
  readonly abandons: number;
  readonly markedDisconnected: number;
}

const BATCH = 50;

/**
 * Reloj del servidor. Cada réplica lo corre cada segundo; varias pueden encontrar la misma
 * partida vencida, pero la jugada se aplica una sola vez: la transacción bloquea la partida
 * y el dominio rechaza un temporizador de un turno que ya pasó (`STALE_TIMER`).
 */
export class Sweeper {
  constructor(
    private readonly deps: {
      db: Db;
      store: MatchStore;
      presence: Presence;
      clock: Clock;
      graceMs: number;
      log: Pick<FastifyBaseLogger, 'error'>;
    },
  ) {}

  async tick(): Promise<SweepResult> {
    const markedDisconnected = await this.reconcilePresence();
    const turnTimeouts = await this.expireTurns();
    const abandons = await this.expireDisconnected();
    return { turnTimeouts, abandons, markedDisconnected };
  }

  /** Turnos vencidos: el servidor juega la carta por defecto. */
  private async expireTurns(): Promise<number> {
    const { rows } = await this.deps.db.query<{ id: string; current_player: string; turn: number }>(
      `SELECT id, current_player, turn FROM matches
        WHERE status = 'playing' AND turn_deadline <= $1 AND current_player IS NOT NULL
        ORDER BY turn_deadline LIMIT $2`,
      [this.deps.clock.now(), BATCH],
    );
    let applied = 0;
    for (const row of rows) {
      // Cada partida por separado: una falla no frena a las demás.
      try {
        const result = await this.deps.store.apply(row.id, {
          type: 'turn_timeout',
          playerId: row.current_player,
          turn: row.turn,
        });
        if (result.kind === 'applied') applied += 1;
      } catch (err) {
        this.deps.log.error({ err, matchId: row.id }, 'falló el temporizador de turno');
      }
    }
    return applied;
  }

  /** Jugadores sin conexión desde hace más que el periodo de gracia: se aplica el abandono. */
  private async expireDisconnected(): Promise<number> {
    const limit = new Date(this.deps.clock.now().getTime() - this.deps.graceMs);
    const { rows } = await this.deps.db.query<{ match_id: string; user_id: string }>(
      `SELECT p.match_id, p.user_id FROM match_players p JOIN matches m ON m.id = p.match_id
        WHERE p.active AND m.status = 'playing' AND p.disconnected_at <= $1
        ORDER BY p.disconnected_at LIMIT $2`,
      [limit, BATCH],
    );
    let applied = 0;
    for (const row of rows) {
      try {
        const result = await this.deps.store.apply(row.match_id, { type: 'abandon', playerId: row.user_id });
        if (result.kind === 'applied') applied += 1;
      } catch (err) {
        this.deps.log.error({ err, matchId: row.match_id }, 'falló la regla de abandono');
      }
    }
    return applied;
  }

  /**
   * Si una réplica se cayó sin cerrar sus conexiones, sus jugadores figuran como conectados
   * en Postgres pero ya no tienen conexiones vivas en Redis. Aquí se corrige eso.
   */
  private async reconcilePresence(): Promise<number> {
    const { rows } = await this.deps.db.query<{ user_id: string }>(
      `SELECT p.user_id FROM match_players p JOIN matches m ON m.id = p.match_id
        WHERE p.active AND m.status = 'playing' AND p.disconnected_at IS NULL LIMIT 500`,
    );
    if (rows.length === 0) return 0;
    const live = await this.deps.presence.liveConnections(rows.map((r) => r.user_id));
    const gone = rows.map((r) => r.user_id).filter((id) => (live.get(id) ?? 0) === 0);
    if (gone.length > 0) await this.deps.presence.markDisconnected(gone, this.deps.clock.now());
    return gone.length;
  }
}
