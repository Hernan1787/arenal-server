import type { Clock } from '../clock.js';
import type { Db } from '../db/tx.js';
import type { RedisClient } from '../infra/redis.js';

const key = (userId: string): string => `arenal:conns:${userId}`;
/** Todas las conexiones de todas las réplicas, para la vista de administración. */
const ALL = 'arenal:conns:all';
const SEP = '|';

/** Una conexión abierta, en cualquier réplica. */
export interface LiveConnection {
  readonly replica: string;
  readonly userId: string;
  readonly connectionId: string;
}

/**
 * Conexiones abiertas por usuario, compartidas entre réplicas. Cada conexión es un miembro
 * de un sorted set cuyo puntaje es su vencimiento; el heartbeat lo renueva. Si una réplica
 * se cae sin cerrar sus conexiones, sus entradas vencen solas.
 */
export class Presence {
  constructor(
    private readonly deps: { redis: RedisClient; db: Db; clock: Clock; leaseMs: number; replicaId: string },
  ) {}

  private member(userId: string, connectionId: string): string {
    return [this.deps.replicaId, userId, connectionId].join(SEP);
  }

  /** Registra la conexión y devuelve cuántas tiene abiertas el usuario contando esta. */
  async connect(userId: string, connectionId: string): Promise<number> {
    const now = this.deps.clock.now().getTime();
    const expires = now + this.deps.leaseMs;
    const k = key(userId);
    const [, , count] = await this.deps.redis
      .multi()
      .zRemRangeByScore(k, '-inf', now)
      .zAdd(k, { score: expires, value: connectionId })
      .zCard(k)
      .pExpire(k, this.deps.leaseMs * 2)
      .zRemRangeByScore(ALL, '-inf', now)
      .zAdd(ALL, { score: expires, value: this.member(userId, connectionId) })
      .exec();
    await this.deps.db.query('UPDATE match_players SET disconnected_at = NULL WHERE user_id = $1 AND active', [userId]);
    return Number(count);
  }

  /** Renueva la conexión (en cada pong). */
  async renew(userId: string, connectionId: string): Promise<void> {
    const expires = this.deps.clock.now().getTime() + this.deps.leaseMs;
    const k = key(userId);
    await this.deps.redis
      .multi()
      .zAdd(k, { score: expires, value: connectionId })
      .pExpire(k, this.deps.leaseMs * 2)
      .zAdd(ALL, { score: expires, value: this.member(userId, connectionId) })
      .exec();
  }

  /** Quita la conexión. Si era la última del usuario, empieza a contar el periodo de gracia. */
  async disconnect(userId: string, connectionId: string): Promise<void> {
    const now = this.deps.clock.now();
    const k = key(userId);
    const [, , remaining] = await this.deps.redis
      .multi()
      .zRem(k, connectionId)
      .zRemRangeByScore(k, '-inf', now.getTime())
      .zCard(k)
      .zRem(ALL, this.member(userId, connectionId))
      .exec();
    if (Number(remaining) === 0) await this.markDisconnected([userId], now);
  }

  /** Cuántas conexiones vivas tiene cada usuario. */
  async liveConnections(userIds: readonly string[]): Promise<Map<string, number>> {
    const now = this.deps.clock.now().getTime();
    const counts = await Promise.all(userIds.map((id) => this.deps.redis.zCount(key(id), now, '+inf')));
    return new Map(userIds.map((id, i) => [id, counts[i] ?? 0]));
  }

  /** Conexiones vivas de todas las réplicas (hasta `limit`) y el total. */
  async listAll(limit: number): Promise<{ total: number; connections: LiveConnection[] }> {
    const now = this.deps.clock.now().getTime();
    await this.deps.redis.zRemRangeByScore(ALL, '-inf', now);
    const [total, members] = await Promise.all([
      this.deps.redis.zCount(ALL, now, '+inf'),
      this.deps.redis.zRange(ALL, now, '+inf', { BY: 'SCORE', LIMIT: { offset: 0, count: limit } }),
    ]);
    const connections = members.flatMap((m): LiveConnection[] => {
      const [replica, userId, connectionId] = m.split(SEP);
      return replica === undefined || userId === undefined || connectionId === undefined
        ? []
        : [{ replica, userId, connectionId }];
    });
    return { total, connections };
  }

  async markDisconnected(userIds: readonly string[], at: Date): Promise<void> {
    await this.deps.db.query(
      'UPDATE match_players SET disconnected_at = $2 WHERE user_id = ANY($1::uuid[]) AND active AND disconnected_at IS NULL',
      [userIds, at],
    );
  }
}
