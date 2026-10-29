import { createHash, randomBytes } from 'node:crypto';
import type { RedisClient } from '../infra/redis.js';

const key = (ticket: string): string => `arenal:ticket:${createHash('sha256').update(ticket).digest('base64url')}`;

/**
 * Tickets para abrir el WebSocket: aleatorios, de un solo uso y de vida corta. Viven en
 * Redis (compartidos entre réplicas) y solo se guarda su hash. Consumirlo es atómico
 * (GETDEL): aunque dos réplicas reciban el mismo ticket, solo una lo acepta.
 */
export class TicketStore {
  constructor(
    private readonly redis: RedisClient,
    readonly ttlSeconds: number,
  ) {}

  async issue(userId: string): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.set(key(ticket), userId, { expiration: { type: 'EX', value: this.ttlSeconds } });
    return ticket;
  }

  /** Devuelve el usuario del ticket y lo invalida; `null` si no existe, venció o ya se usó. */
  async consume(ticket: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const userId = await this.redis.getDel(key(ticket));
    return typeof userId === 'string' ? userId : null;
  }
}
