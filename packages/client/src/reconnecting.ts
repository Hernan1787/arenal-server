import type { ArenalApi } from './api.js';
import { RealtimeSession, type RealtimeHandlers } from './realtime.js';

/**
 * Códigos de cierre con los que no se reintenta: cierre propio (1000), mensaje fuera de la
 * política (1008), cuenta suspendida (4003) y demasiadas conexiones o mensajes (4029).
 * Cualquier otro (1012 al apagarse una réplica, 1006 si se cortó la red…) se reintenta.
 */
const FINAL_CLOSE_CODES = new Set([1000, 1008, 4003, 4029]);

export interface ReconnectOptions {
  /** Se perdió la conexión y se va a reintentar. */
  readonly onDisconnect?: (code: number, reason: string) => void;
  /** Volvió a conectar; el servidor manda enseguida el snapshot de la partida en curso. */
  readonly onReconnect?: (attempts: number) => void;
  /** Ya no se reintenta: cierre propio, un código final o se agotaron los intentos. */
  readonly onGiveUp?: (code: number, reason: string) => void;
  readonly maxAttempts?: number;
  /** Espera antes del primer reintento; se duplica en cada intento hasta `maxDelayMs`. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Conexión en tiempo real que se recupera sola. Cuando una réplica se apaga (por ejemplo al
 * cambiar de revisión en Container Apps) cierra los WebSocket con 1012: esta clase pide un ticket
 * nuevo, abre otra conexión (que el balanceador manda a una réplica viva) y el servidor le manda
 * el snapshot de la partida. La partida sigue donde estaba porque su estado vive en Postgres.
 */
export class ReconnectingSession {
  private session: RealtimeSession | null = null;
  private stopped = false;

  private constructor(
    private readonly api: ArenalApi,
    private readonly handlers: RealtimeHandlers,
    private readonly options: ReconnectOptions,
  ) {}

  static async open(
    api: ArenalApi,
    handlers: RealtimeHandlers = {},
    options: ReconnectOptions = {},
  ): Promise<ReconnectingSession> {
    const reconnecting = new ReconnectingSession(api, handlers, options);
    // La primera conexión también se reintenta: una réplica que se está apagando la rechaza con 503.
    const maxAttempts = options.maxAttempts ?? 10;
    let delay = options.initialDelayMs ?? 250;
    for (let attempt = 1; ; attempt++) {
      try {
        reconnecting.session = await reconnecting.connect();
        return reconnecting;
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await sleep(delay + Math.random() * delay);
        delay = Math.min(delay * 2, options.maxDelayMs ?? 5_000);
      }
    }
  }

  /** La conexión vigente. Cambia en cada reconexión: no hay que guardarla. */
  get current(): RealtimeSession {
    if (this.session === null) throw new Error('Sin conexión');
    return this.session;
  }

  close(): void {
    this.stopped = true;
    this.session?.close();
  }

  private async connect(): Promise<RealtimeSession> {
    return RealtimeSession.open(this.api.baseUrl, await this.api.realtimeTicket(), {
      ...this.handlers,
      onClose: (code, reason) => {
        void this.closed(code, reason);
      },
    });
  }

  private async closed(code: number, reason: string): Promise<void> {
    if (this.stopped || FINAL_CLOSE_CODES.has(code)) {
      this.giveUp(code, reason);
      return;
    }
    this.options.onDisconnect?.(code, reason);
    const maxAttempts = this.options.maxAttempts ?? 10;
    let delay = this.options.initialDelayMs ?? 250;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(delay + Math.random() * delay);
      // Pudo haberse cerrado a propósito mientras esperaba.
      if (this.isStopped()) return;
      try {
        this.session = await this.connect();
        this.options.onReconnect?.(attempt);
        return;
      } catch {
        delay = Math.min(delay * 2, this.options.maxDelayMs ?? 5_000);
      }
    }
    this.giveUp(code, reason);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private giveUp(code: number, reason: string): void {
    this.options.onGiveUp?.(code, reason);
    this.handlers.onClose?.(code, reason);
  }
}
