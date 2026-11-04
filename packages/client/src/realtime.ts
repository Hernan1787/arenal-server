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

/**
 * Lo único que la sesión usa de un WebSocket. Lo cumplen el del navegador y el de la librería `ws`
 * (que usa Node, ver index.ts); así el mismo cliente sirve en los dos lados.
 */
export interface WebSocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { readonly code: number; readonly reason: string }) => void): void;
  addEventListener(type: 'error', listener: (event: { readonly message?: string }) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

// En el navegador, el WebSocket nativo. En Node, index.ts lo cambia por el de `ws`.
let createWebSocket: WebSocketFactory = (url) => new WebSocket(url);

/** Cambia la implementación de WebSocket que usan todas las sesiones nuevas. */
export function useWebSocket(factory: WebSocketFactory): void {
  createWebSocket = factory;
}

const newId = (): string => globalThis.crypto.randomUUID();

const asBytes = (part: unknown): Uint8Array =>
  part instanceof ArrayBuffer ? new Uint8Array(part) : (part as Uint8Array);

/** El servidor manda texto; según la implementación llega como string o como bytes. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  const decoder = new TextDecoder();
  if (!Array.isArray(data)) return decoder.decode(asBytes(data));
  const parts = data.map(asBytes);
  const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return decoder.decode(joined);
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
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Conexión en tiempo real de un jugador. Valida cada mensaje del servidor contra el contrato,
 * mantiene la vista de la partida aplicando los eventos (sin pedir el estado otra vez) y
 * empareja cada jugada con su `ack` o su error.
 */
export class RealtimeSession {
  private current: PlayerView | null = null;
  private lastSeq = 0;
  /** Si el handshake terminó: un cierre antes de abrir no es una desconexión, es un rechazo. */
  private opened = false;
  private readonly pending = new Map<string, Pending>();
  /** Eventos con un `seq` que no seguía al anterior (no debería pasar nunca). */
  gaps = 0;
  /** Mensajes del servidor que no cumplían el contrato. */
  invalidMessages = 0;

  private constructor(
    private readonly ws: WebSocketLike,
    private readonly handlers: RealtimeHandlers,
    private readonly ackTimeoutMs: number,
  ) {
    ws.addEventListener('message', (message) => {
      this.onMessage(toText(message.data));
    });
    ws.addEventListener('open', () => {
      this.opened = true;
    });
    ws.addEventListener('close', (event) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`La conexión se cerró (${event.code})`));
      }
      this.pending.clear();
      if (this.opened) handlers.onClose?.(event.code, event.reason);
    });
  }

  /**
   * Abre el WebSocket con un ticket de `POST /v1/realtime/tickets`. En Node usa la librería `ws`:
   * desde Node 26, el WebSocket incluido intenta WebSocket sobre HTTP/2 (CONNECT extendido) cuando
   * el servidor lo anuncia, y el ingress de Container Apps lo anuncia pero no lo lleva hasta la app.
   * `ws` y los navegadores usan HTTP/1.1 con `Upgrade`, que es lo que entiende el servidor.
   */
  static open(
    baseUrl: string,
    ticket: string,
    handlers: RealtimeHandlers = {},
    options: { ackTimeoutMs?: number; openTimeoutMs?: number } = {},
  ): Promise<RealtimeSession> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
    return new Promise((resolve, reject) => {
      const ws = createWebSocket(url);
      const session = new RealtimeSession(ws, handlers, options.ackTimeoutMs ?? 10_000);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('El WebSocket no abrió a tiempo'));
      }, options.openTimeoutMs ?? 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(session);
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        // `ws` dice qué respondió el servidor (por ejemplo «Unexpected server response: 401»);
        // el navegador no da detalles.
        reject(new Error(`Falló el handshake del WebSocket${event.message ? `: ${event.message}` : ''}`));
      });
    });
  }

  get view(): PlayerView | null {
    return this.current;
  }

  get seq(): number {
    return this.lastSeq;
  }

  /**
   * Juega una carta sobre la versión que conoce el cliente. `targetId` es el rival para Ceniza y
   * Robo. Resuelve con el `ack`.
   */
  playCard(cardId: string, targetId?: string, moveId: string = newId()): Promise<Ack> {
    const view = this.requireView();
    return this.send(moveId, {
      v: PROTOCOL_VERSION,
      type: 'play_card',
      id: moveId,
      matchId: view.matchId,
      expectedSeq: this.lastSeq,
      payload: targetId === undefined ? { cardId } : { cardId, targetId },
    });
  }

  leaveMatch(): Promise<Ack> {
    const view = this.requireView();
    const id = newId();
    return this.send(id, { v: PROTOCOL_VERSION, type: 'leave_match', id, matchId: view.matchId });
  }

  /** Pide el estado completo otra vez (llega como snapshot). */
  resume(): void {
    const view = this.requireView();
    this.ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'resume',
        id: newId(),
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
