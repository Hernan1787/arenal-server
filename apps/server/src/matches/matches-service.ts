import { MatchResultSchema } from '@arenal/contracts';
import { projectEvent, viewFor, type PlayerEvent, type PlayerView } from '@arenal/domain';
import type { z } from 'zod';
import type { Db } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import type { MatchOrigin, MatchStatus, MatchStore } from './match-store.js';

export interface MatchSnapshot {
  readonly matchId: string;
  readonly seq: number;
  readonly view: PlayerView;
}

export interface MatchSummary {
  readonly matchId: string;
  readonly origin: MatchOrigin;
  readonly status: MatchStatus;
  readonly players: { readonly id: string; readonly displayName: string }[];
  readonly result: z.output<typeof MatchResultSchema> | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface ReplayEntry {
  readonly seq: number;
  readonly event: PlayerEvent;
}

/** Lecturas de partidas para la API: siempre filtradas para quien pregunta. */
export class MatchesService {
  constructor(private readonly deps: { db: Db; store: MatchStore }) {}

  async isParticipant(matchId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.deps.db.query('SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2', [
      matchId,
      userId,
    ]);
    return rowCount === 1;
  }

  /** Estado visible para un participante. Sirve al conectarse; los cambios llegan por WebSocket. */
  async snapshot(matchId: string, userId: string): Promise<MatchSnapshot> {
    await this.requireParticipant(matchId, userId);
    const loaded = await this.deps.store.load(matchId);
    if (loaded === undefined) throw notFound('La partida');
    return { matchId, seq: loaded.row.seq, view: viewFor(loaded.state, userId) };
  }

  /** Repetición jugada por jugada, desde el punto de vista de quien la pide. Solo partidas terminadas. */
  async replay(matchId: string, userId: string): Promise<{ matchId: string; events: ReplayEntry[] }> {
    await this.requireParticipant(matchId, userId);
    const { rows } = await this.deps.db.query<{ status: MatchStatus }>('SELECT status FROM matches WHERE id = $1', [matchId]);
    if (rows[0]?.status === 'playing') {
      throw new AppError('conflict', 'La repetición está disponible cuando la partida termina', 'MATCH_IN_PROGRESS');
    }
    const events = await this.deps.store.events(matchId);
    return { matchId, events: events.map(({ seq, event }) => ({ seq, event: projectEvent(event, userId) })) };
  }

  /** Historial del usuario, de la más nueva a la más vieja. */
  async history(userId: string, query: { limit: number; cursor?: string | undefined }): Promise<Page<MatchSummary>> {
    const cursor = decodeCursor(query.cursor);
    const { rows } = await this.deps.db.query<{
      id: string;
      origin: MatchOrigin;
      status: MatchStatus;
      result: unknown;
      created_at: Date;
      finished_at: Date | null;
      players: { id: string; displayName: string }[];
    }>(
      `SELECT m.id, m.origin, m.status, m.result, m.created_at, m.finished_at,
              (SELECT json_agg(json_build_object('id', u.id, 'displayName', u.display_name) ORDER BY u.display_name)
                 FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = m.id) AS players
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1
          AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4`,
      [userId, cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    return toPage(
      rows,
      query.limit,
      (r) => ({
        matchId: r.id,
        origin: r.origin,
        status: r.status,
        players: r.players,
        result: r.result === null ? null : MatchResultSchema.parse(r.result),
        createdAt: r.created_at.toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
      }),
      (r) => ({ at: r.created_at, id: r.id }),
    );
  }

  /**
   * Quien no participa recibe 404 y no 403: así no se puede averiguar qué partidas existen
   * probando IDs.
   */
  private async requireParticipant(matchId: string, userId: string): Promise<void> {
    if (!(await this.isParticipant(matchId, userId))) throw notFound('La partida');
  }
}
