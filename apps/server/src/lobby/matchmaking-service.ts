import type { Clock } from '../clock.js';
import { withTransaction, type Db, type Tx } from '../db/tx.js';
import type { MatchStore } from '../matches/match-store.js';
import { noopBus, type EventBus } from '../realtime/bus.js';
import { ensureAvailable, lockUser } from './availability.js';

export type TicketStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly waitedMs: number; readonly maxWaitMs: number }
  | { readonly state: 'matched'; readonly matchId: string }
  | { readonly state: 'expired' };

export interface MatchmakingPolicy {
  /** Tamaño de las partidas que arma la cola. */
  readonly matchSize: number;
  /** Desde esta espera se arma partida con los que haya, si son al menos 2. */
  readonly fillAfterMs: number;
  /** Tiempo máximo de espera: si no se arma partida antes, el ticket vence. */
  readonly maxWaitMs: number;
}

/** Clave del candado de Postgres que hace que solo una réplica arme partidas a la vez. */
const MATCHMAKER_LOCK_KEY = 72_601_002;

/**
 * Cola rápida. Los tickets viven en Postgres. Armar partidas corre bajo un candado de
 * transacción, así varias réplicas pueden llamar al emparejador sin repartir a un jugador
 * en dos partidas; además, el índice único de jugadores activos lo garantiza en la base.
 */
export class MatchmakingService {
  private readonly bus: EventBus;

  constructor(
    private readonly deps: { db: Db; store: MatchStore; clock: Clock; policy: MatchmakingPolicy; bus?: EventBus },
  ) {
    this.bus = deps.bus ?? noopBus;
  }

  async enqueue(userId: string): Promise<TicketStatus> {
    await withTransaction(this.deps.db, async (tx) => {
      await lockUser(tx, userId);
      await ensureAvailable(tx, userId);
      await tx.query(
        `INSERT INTO matchmaking_tickets (user_id, status, enqueued_at) VALUES ($1, 'waiting', $2)
         ON CONFLICT (user_id) DO UPDATE SET status = 'waiting', enqueued_at = EXCLUDED.enqueued_at`,
        [userId, this.deps.clock.now()],
      );
    });
    await this.runMatchmaker();
    return this.status(userId);
  }

  async cancel(userId: string): Promise<void> {
    await this.deps.db.query('DELETE FROM matchmaking_tickets WHERE user_id = $1', [userId]);
  }

  async status(userId: string): Promise<TicketStatus> {
    const { rows } = await this.deps.db.query<{
      status: 'waiting' | 'expired' | null;
      enqueued_at: Date | null;
      match_id: string | null;
    }>(
      `SELECT t.status, t.enqueued_at,
              (SELECT p.match_id FROM match_players p WHERE p.user_id = $1 AND p.active LIMIT 1) AS match_id
         FROM (SELECT 1) AS one
         LEFT JOIN matchmaking_tickets t ON t.user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (row !== undefined && row.match_id !== null) return { state: 'matched', matchId: row.match_id };
    if (row?.status === 'waiting' && row.enqueued_at !== null) {
      return {
        state: 'waiting',
        waitedMs: Math.max(0, this.deps.clock.now().getTime() - row.enqueued_at.getTime()),
        maxWaitMs: this.deps.policy.maxWaitMs,
      };
    }
    if (row?.status === 'expired') return { state: 'expired' };
    return { state: 'idle' };
  }

  /**
   * Arma todas las partidas posibles con los tickets en espera y vence los que pasaron el
   * tiempo máximo. Se llama al encolar y cada segundo desde un barrido.
   */
  async runMatchmaker(): Promise<string[]> {
    const created = await this.formMatches();
    // Ya confirmadas, se avisa a los jugadores conectados por WebSocket.
    await Promise.all(created.map((m) => this.bus.matchAssigned(m.matchId, m.userIds)));
    return created.map((m) => m.matchId);
  }

  private formMatches(): Promise<{ matchId: string; userIds: readonly string[] }[]> {
    const { matchSize, fillAfterMs, maxWaitMs } = this.deps.policy;
    return withTransaction(this.deps.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MATCHMAKER_LOCK_KEY]);
      const now = this.deps.clock.now().getTime();
      const { rows } = await tx.query<{ user_id: string; enqueued_at: Date }>(
        `SELECT user_id, enqueued_at FROM matchmaking_tickets WHERE status = 'waiting' ORDER BY enqueued_at, user_id FOR UPDATE`,
      );
      // Defensa extra: un ticket de alguien que ya juega no debe trabar la cola completa.
      const busy = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM match_players WHERE active AND user_id = ANY($1::uuid[])',
        [rows.map((r) => r.user_id)],
      );
      const busyIds = new Set(busy.rows.map((r) => r.user_id));
      if (busyIds.size > 0) {
        await tx.query('DELETE FROM matchmaking_tickets WHERE user_id = ANY($1::uuid[])', [[...busyIds]]);
      }
      const waiting = rows.filter((r) => !busyIds.has(r.user_id));
      const created: { matchId: string; userIds: readonly string[] }[] = [];

      while (waiting.length >= matchSize) {
        created.push(
          await this.formMatch(
            tx,
            waiting.splice(0, matchSize).map((t) => t.user_id),
          ),
        );
      }
      const oldest = waiting[0];
      if (waiting.length >= 2 && oldest !== undefined && now - oldest.enqueued_at.getTime() >= fillAfterMs) {
        created.push(
          await this.formMatch(
            tx,
            waiting.splice(0).map((t) => t.user_id),
          ),
        );
      }

      const expired = waiting.filter((t) => now - t.enqueued_at.getTime() >= maxWaitMs).map((t) => t.user_id);
      if (expired.length > 0) {
        await tx.query(`UPDATE matchmaking_tickets SET status = 'expired' WHERE user_id = ANY($1::uuid[])`, [expired]);
      }
      return created;
    });
  }

  private async formMatch(
    tx: Tx,
    userIds: readonly string[],
  ): Promise<{ matchId: string; userIds: readonly string[] }> {
    await tx.query('DELETE FROM matchmaking_tickets WHERE user_id = ANY($1::uuid[])', [userIds]);
    const { matchId } = await this.deps.store.create(tx, 'matchmaking', userIds);
    return { matchId, userIds };
  }
}
