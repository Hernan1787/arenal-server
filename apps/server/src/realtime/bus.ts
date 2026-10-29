import type { DomainEvent } from '@arenal/domain';
import type { FastifyBaseLogger } from 'fastify';
import type { RedisClient } from '../infra/redis.js';

export interface SequencedEvent {
  readonly seq: number;
  readonly event: DomainEvent;
}

/**
 * Avisos entre réplicas. Se publican después de confirmar la transacción en Postgres, así
 * nunca se anuncia algo que no quedó guardado. Si un aviso se pierde, la réplica que reciba
 * el siguiente rellena el hueco leyendo de Postgres.
 */
export interface EventBus {
  /** Eventos nuevos de una partida, ya guardados y con su secuencia. */
  matchEvents(matchId: string, events: readonly SequencedEvent[]): Promise<void>;
  /** Se creó una partida con estos jugadores (sala que arrancó o cola). */
  matchAssigned(matchId: string, playerIds: readonly string[]): Promise<void>;
}

export const noopBus: EventBus = {
  matchEvents: () => Promise.resolve(),
  matchAssigned: () => Promise.resolve(),
};

export const matchChannel = (matchId: string): string => `arenal:match:${matchId}`;
export const userChannel = (userId: string): string => `arenal:user:${userId}`;

export interface MatchEventsMessage {
  readonly matchId: string;
  readonly events: readonly SequencedEvent[];
}

export interface MatchAssignedMessage {
  readonly matchId: string;
}

/** Bus sobre Redis pub/sub. Los eventos viajan completos: Redis es interno, nunca llega a un jugador. */
export class RedisEventBus implements EventBus {
  constructor(
    private readonly publisher: RedisClient,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  async matchEvents(matchId: string, events: readonly SequencedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const message: MatchEventsMessage = { matchId, events };
    await this.publish(matchChannel(matchId), message);
  }

  async matchAssigned(matchId: string, playerIds: readonly string[]): Promise<void> {
    const message: MatchAssignedMessage = { matchId };
    await Promise.all(playerIds.map((id) => this.publish(userChannel(id), message)));
  }

  private async publish(channel: string, message: object): Promise<void> {
    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      // La jugada ya está confirmada: un aviso perdido se recupera con el relleno de huecos.
      this.log.warn({ err, channel }, 'no se pudo publicar el aviso en Redis');
    }
  }
}
