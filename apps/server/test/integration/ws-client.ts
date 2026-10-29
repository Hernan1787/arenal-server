import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@arenal/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { TestUser } from './harness.js';

export async function ticketFor(app: FastifyInstance, user: TestUser): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/realtime/tickets', headers: user.auth });
  if (res.statusCode !== 201) throw new Error(`No se pudo pedir el ticket: ${res.statusCode} ${res.body}`);
  return res.json<{ ticket: string }>().ticket;
}

export interface ConnectOptions {
  readonly origin?: string;
  /** Si es false, el cliente no responde los ping del servidor (para probar el heartbeat). */
  readonly autoPong?: boolean;
}

/** Intenta abrir el WebSocket y devuelve el código HTTP si el servidor rechaza el handshake. */
export function handshakeStatus(baseUrl: string, query: string, options: ConnectOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${baseUrl}/v1/realtime${query}`,
      options.origin === undefined ? {} : { origin: options.origin },
    );
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', (err) => {
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

type Predicate = (m: ServerMessage) => boolean;

/** Cliente de prueba: guarda todo lo que recibe y permite esperar mensajes concretos. */
export class TestSocket {
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private cursor = 0;
  private listeners: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.received.push(
        JSON.parse(
          Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(data as Buffer[]).toString('utf8'),
        ) as ServerMessage,
      );
      for (const l of this.listeners) l();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        for (const l of this.listeners) l();
      });
    });
  }

  static open(baseUrl: string, ticket: string, options: ConnectOptions = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${baseUrl}/v1/realtime?ticket=${ticket}`, {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        autoPong: options.autoPong ?? true,
      });
      const socket = new TestSocket(ws);
      ws.once('open', () => {
        resolve(socket);
      });
      ws.once('error', reject);
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Espera el siguiente mensaje (desde el último consumido) que cumpla la condición. */
  next(predicate: Predicate = () => true, timeoutMs = 4_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        while (this.cursor < this.received.length) {
          const message = this.received[this.cursor];
          this.cursor += 1;
          if (message !== undefined && predicate(message)) {
            cleanup();
            resolve(message);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `No llegó el mensaje esperado en ${timeoutMs} ms. Recibidos: ${JSON.stringify(this.received.slice(-5))}`,
          ),
        );
      }, timeoutMs);
      const listener = (): void => {
        check();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
      if (!check()) this.listeners.push(listener);
    });
  }

  /** Espera a tener todos los eventos hasta `seq` y los devuelve en orden de llegada. */
  async eventsUpTo(seq: number, timeoutMs = 4_000): Promise<Extract<ServerMessage, { type: 'event' }>[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = this.received.filter((m): m is Extract<ServerMessage, { type: 'event' }> => m.type === 'event');
      if (events.some((e) => e.seq >= seq)) return events;
      if (Date.now() > deadline)
        throw new Error(`No llegaron eventos hasta ${seq}; último: ${events.at(-1)?.seq ?? 'ninguno'}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close(1000);
    return this.closed;
  }
}

export const play = (matchId: string, cardId: string, expectedSeq: number, id: string = randomUUID()) => ({
  v: 1,
  type: 'play_card',
  id,
  matchId,
  expectedSeq,
  payload: { cardId },
});
