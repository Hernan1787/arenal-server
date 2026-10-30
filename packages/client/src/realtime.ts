import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, ServerMessage, type ErrorCode } from '@arenal/contracts';
import { applyPlayerEvent, type PlayerEvent, type PlayerView } from '@arenal/domain';

export type Ack = Extract<ServerMessage, { type: 'ack' }>;
export type ServerError = Extract<ServerMessage, { type: 'error' }>;

export interface RealtimeHandlers {
  /** Llegó el estado completo (al conectar, al asignar partida o tras `resume`). */
  onSnapshot?: (view: PlayerView, seq: number) => void;
  /** Llegó un evento; `view` ya lo tiene aplicado. */
  onEvent?: (event: PlayerEvent, seq: number, view: PlayerView) => void;
  onClose?: (code: number, reason: string) => void;
}

/** Error que el servidor mandó en respuesta a un mensaje propio. */
export class RejectedError extends Error {
  override readonly name = 'RejectedError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`);
  }
}

interface Pending {
  resolve: (ack: Ack) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Conexión en tiempo real de un jugador. Valida cada mensaje del servidor contra el contrato,
 * mantiene la vista de la partida aplicando los eventos (sin pedir el estado otra vez) y
 * empareja cada jugada con su `ack` o su error.
 */
export class RealtimeSession {
  private current: PlayerView | null = null;
  private lastSeq = 0;
  private readonly pending = new Map<string, Pending>();
  /** Eventos con un `seq` que no seguía al anterior (no debería pasar nunca). */
  gaps = 0;
  /** Mensajes del servidor que no cumplían el contrato. */
  invalidMessages = 0;

  private constructor(
    private readonly ws: WebSocket,
    private readonly handlers: RealtimeHandlers,
    private readonly ackTimeoutMs: number,
  ) {
    ws.addEventListener('message', (message) => {
      this.onMessage(String(message.data));
    });
    ws.addEventListener('close', (event) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`La conexión se cerró (${event.code})`));
      }
      this.pending.clear();
      handlers.onClose?.(event.code, event.reason);
    });
  }

  /** Abre el WebSocket con un ticket de `POST /v1/realtime/tickets`. */
  static open(
    baseUrl: string,
    ticket: string,
    handlers: RealtimeHandlers = {},
    options: { ackTimeoutMs?: number; openTimeoutMs?: number } = {},
  ): Promise<RealtimeSession> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const session = new RealtimeSession(ws, handlers, options.ackTimeoutMs ?? 10_000);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('El WebSocket no abrió a tiempo'));
      }, options.openTimeoutMs ?? 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(session);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Falló el handshake del WebSocket'));
      });
    });
  }

  get view(): PlayerView | null {
    return this.current;
  }

  get seq(): number {
    return this.lastSeq;
  }

  /** Juega una carta sobre la versión que conoce el cliente. Resuelve con el `ack`. */
  playCard(cardId: string, moveId: string = randomUUID()): Promise<Ack> {
    const view = this.requireView();
    return this.send(moveId, {
      v: PROTOCOL_VERSION,
      type: 'play_card',
      id: moveId,
      matchId: view.matchId,
      expectedSeq: this.lastSeq,
      payload: { cardId },
    });
  }

  leaveMatch(): Promise<Ack> {
    const view = this.requireView();
    const id = randomUUID();
    return this.send(id, { v: PROTOCOL_VERSION, type: 'leave_match', id, matchId: view.matchId });
  }

  /** Pide el estado completo otra vez (llega como snapshot). */
  resume(): void {
    const view = this.requireView();
    this.ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'resume',
        id: randomUUID(),
        matchId: view.matchId,
        lastSeq: this.lastSeq,
      }),
    );
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  private requireView(): PlayerView {
    if (this.current === null) throw new Error('Todavía no hay partida');
    return this.current;
  }

  private send(id: string, message: object): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sin respuesta del servidor en ${this.ackTimeoutMs} ms`));
      }, this.ackTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }

  private settle(id: string | null, outcome: { ack: Ack } | { error: ServerError }): void {
    if (id === null) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('ack' in outcome) pending.resolve(outcome.ack);
    else pending.reject(new RejectedError(outcome.error.code, outcome.error.message, outcome.error.retryable));
  }

  private onMessage(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.invalidMessages += 1;
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) {
      this.invalidMessages += 1;
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'snapshot': {
        this.current = message.view;
        this.lastSeq = message.seq;
        this.handlers.onSnapshot?.(this.current, message.seq);
        return;
      }
      case 'event': {
        if (this.current === null || message.matchId !== this.current.matchId) return;
        if (message.seq !== this.lastSeq + 1) this.gaps += 1;
        const event = message.event as PlayerEvent;
        this.current = applyPlayerEvent(this.current, event);
        this.lastSeq = message.seq;
        this.handlers.onEvent?.(event, message.seq, this.current);
        return;
      }
      case 'ack':
        this.settle(message.id, { ack: message });
        return;
      case 'error':
        this.settle(message.id, { error: message });
        return;
    }
  }
}
