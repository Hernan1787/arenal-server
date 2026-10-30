import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ERROR_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  type CLOSE_CODES,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@arenal/contracts';
import { projectEvent, viewFor } from '@arenal/domain';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AuthService } from '../auth/auth-service.js';
import { SpanKind } from '@opentelemetry/api';
import type { ApplyResult, MatchStore } from '../matches/match-store.js';
import { createGameMetrics, type GameMetrics } from '../observability/metrics.js';
import { attr, withSpan } from '../observability/tracing.js';
import type { MatchesService } from '../matches/matches-service.js';
import type { RedisClient } from '../infra/redis.js';
import { matchChannel, userChannel, type MatchEventsMessage, type SequencedEvent, type UserMessage } from './bus.js';
import type { Presence } from './presence.js';
import type { TicketStore } from './tickets.js';

export const REALTIME_PATH = '/v1/realtime';

export interface RealtimeOptions {
  readonly allowedOrigins: readonly string[];
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxConnectionsPerUser: number;
  readonly messagesPerSecond: number;
  readonly messageBurst: number;
}

export interface RealtimeDeps {
  readonly store: MatchStore;
  readonly matches: MatchesService;
  readonly auth: Pick<AuthService, 'accountStatus'>;
  readonly tickets: TicketStore;
  readonly presence: Presence;
  /** Conexión de Redis dedicada a suscripciones (no puede usarse para otros comandos). */
  readonly subscriber: RedisClient;
  readonly log: FastifyBaseLogger;
  readonly isDraining: () => boolean;
  readonly options: RealtimeOptions;
  readonly metrics?: GameMetrics;
}

type CloseCode = keyof typeof CLOSE_CODES;

/** El dominio entrega estructuras de solo lectura; para mandarlas basta con que coincida la forma. */
type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type Outgoing = DeepReadonly<ServerMessage>;

/** Cubeta de fichas: permite ráfagas cortas y limita el ritmo sostenido de mensajes. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class Session {
  readonly id = randomUUID();
  matchId: string | null = null;
  lastSeq = 0;
  lastPong = Date.now();
  violations = 0;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly userId: string,
    readonly socket: WebSocket,
    readonly bucket: TokenBucket,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Las tareas de entrega (snapshot, eventos, rellenos) corren de a una por conexión, en el
   * orden en que llegan. Así el jugador recibe la secuencia sin desorden.
   */
  enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => {
      this.log.error({ err, userId: this.userId, matchId: this.matchId }, 'falló una entrega por WebSocket');
    });
  }

  /** Un método y no un campo: el estado cambia entre un `await` y otro, y así TypeScript no lo da por fijo. */
  isClosed(): boolean {
    return this.closed;
  }

  markClosed(): void {
    this.closed = true;
  }

  send(message: Outgoing): void {
    if (!this.closed && this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }

  error(id: string | null, code: ErrorCode, message: string, retryable = false): void {
    this.send({ v: PROTOCOL_VERSION, type: 'error', id, code, message, retryable });
  }

  close(code: CloseCode, reason: string): void {
    if (this.closed) return;
    this.socket.close(code, reason);
    // Si el cliente no responde al cierre, se corta igual.
    setTimeout(() => {
      this.socket.terminate();
    }, 2_000).unref();
  }
}

const KNOWN_ERRORS = new Set<string>(ERROR_CODES);
const toErrorCode = (code: string): ErrorCode => (KNOWN_ERRORS.has(code) ? (code as ErrorCode) : 'INTERNAL');

/**
 * Puerta de entrada del tiempo real. Autentica en el handshake con un ticket de un solo uso,
 * valida cada mensaje contra su esquema antes de tocar el dominio, y reparte los eventos de
 * cada partida (llegan por Redis desde cualquier réplica) filtrados para cada jugador.
 */
export class RealtimeGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  private readonly byMatch = new Map<string, Set<Session>>();
  private readonly byUser = new Map<string, Set<Session>>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly metrics: GameMetrics;

  constructor(private readonly deps: RealtimeDeps) {
    this.metrics = deps.metrics ?? createGameMetrics();
    this.heartbeat = setInterval(() => {
      this.checkHeartbeats();
    }, deps.options.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    let n = 0;
    for (const sessions of this.byUser.values()) n += sessions.size;
    return n;
  }

  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined);
      this.handleUpgrade(request, socket, head).catch((err: unknown) => {
        this.deps.log.error({ err }, 'falló el handshake de WebSocket');
        reject(socket, 500, 'Error interno');
      });
    });
  }

  /** Cierra todas las conexiones (1012 = reiniciando) y deja de escuchar. */
  async close(code: CloseCode = 1012, reason = 'La réplica se está reiniciando; reconecta'): Promise<void> {
    clearInterval(this.heartbeat);
    // Se recorren los sockets de `ws` y no solo las sesiones registradas: una conexión que
    // todavía se está registrando también tiene que recibir el cierre.
    for (const ws of this.wss.clients) {
      ws.close(code, reason);
      setTimeout(() => {
        ws.terminate();
      }, 2_000).unref();
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }

  // --- Handshake -----------------------------------------------------------------------------

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== REALTIME_PATH) {
      reject(socket, 404, 'No existe');
      return;
    }
    if (this.deps.isDraining()) {
      reject(socket, 503, 'La réplica se está apagando');
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !this.deps.options.allowedOrigins.includes(origin)) {
      reject(socket, 403, 'Origen no permitido');
      return;
    }

    const ticket = url.searchParams.get('ticket');
    const userId = ticket === null ? null : await this.deps.tickets.consume(ticket);
    if (userId === null) {
      reject(socket, 401, 'Falta el ticket o ya no es válido');
      return;
    }

    const account = await this.deps.auth.accountStatus(userId);
    if (account === null) {
      reject(socket, 401, 'La cuenta ya no existe');
      return;
    }
    if (account.suspended) {
      reject(socket, 403, 'La cuenta está suspendida');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      void this.onConnection(ws, userId);
    });
  }

  private async onConnection(ws: WebSocket, userId: string): Promise<void> {
    const { options } = this.deps;
    const session = new Session(
      userId,
      ws,
      new TokenBucket(options.messagesPerSecond, options.messageBurst),
      this.deps.log,
    );
    ws.on('error', (err) => {
      this.deps.log.warn({ err, userId }, 'error en la conexión WebSocket');
    });
    ws.on('close', (code) => {
      void this.onClose(session, code);
    });
    ws.on('pong', () => {
      session.lastPong = Date.now();
      this.deps.presence.renew(userId, session.id).catch(() => undefined);
    });
    ws.on('message', (data, isBinary) => {
      this.onMessage(session, data, isBinary);
    });

    const count = await this.deps.presence.connect(userId, session.id);
    // Si la conexión se cerró mientras se registraba, se deshace lo hecho y no sigue.
    if (session.isClosed()) return this.deps.presence.disconnect(userId, session.id);
    if (count > options.maxConnectionsPerUser) {
      session.close(4029, 'Demasiadas conexiones abiertas');
      return;
    }
    await this.addUserSession(session);
    if (session.isClosed()) return this.removeUserSession(session);
    // Ya suscrito al canal del usuario, se revisa la cuenta otra vez: si la suspendieron entre
    // el handshake y la suscripción, el aviso por Redis se pudo perder, pero esta lectura lo ve.
    if ((await this.deps.auth.accountStatus(userId))?.suspended !== false) {
      session.close(4003, 'La cuenta fue suspendida');
      return;
    }

    const active = await this.deps.matches.activeMatchOf(userId);
    this.deps.log.info({ userId, connectionId: session.id, matchId: active }, 'conexión abierta');
    if (active !== null && !session.isClosed()) session.enqueue(() => this.attachToMatch(session, active));
  }

  private async onClose(session: Session, code: number): Promise<void> {
    session.markClosed();
    this.deps.log.info(
      { userId: session.userId, connectionId: session.id, matchId: session.matchId, code },
      'conexión cerrada',
    );
    await this.removeFromMatch(session);
    await this.removeUserSession(session);
    await this.deps.presence.disconnect(session.userId, session.id).catch((err: unknown) => {
      this.deps.log.warn({ err }, 'no se pudo registrar la desconexión');
    });
  }

  // --- Mensajes del cliente ------------------------------------------------------------------

  private onMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (!session.bucket.take()) {
      session.violations += 1;
      this.metrics.messageRejected('RATE_LIMITED');
      session.error(null, 'RATE_LIMITED', 'Demasiados mensajes; baja el ritmo', true);
      if (session.violations > 20) session.close(4029, 'Demasiados mensajes');
      return;
    }
    const reject = (id: string | null, code: ErrorCode, message: string): void => {
      this.metrics.messageRejected(code);
      session.error(id, code, message);
    };
    if (isBinary) {
      reject(null, 'INVALID_MESSAGE', 'Solo se aceptan mensajes de texto JSON');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawToString(data));
    } catch {
      reject(null, 'INVALID_MESSAGE', 'El mensaje no es JSON válido');
      return;
    }
    const id = extractId(raw);
    if (typeof raw === 'object' && raw !== null && 'v' in raw && raw.v !== PROTOCOL_VERSION) {
      reject(id, 'UNSUPPORTED_VERSION', `Este servidor habla la versión ${PROTOCOL_VERSION} del protocolo`);
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      reject(id, 'INVALID_MESSAGE', parsed.reason);
      return;
    }

    const message = parsed.message;
    // Cada mensaje es una traza propia: las consultas y los logs que produce quedan adentro,
    // con el ID de la partida y del jugador para buscarla.
    withSpan(
      `ws ${message.type}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [attr.matchId]: message.matchId,
          [attr.playerId]: session.userId,
          'arenal.message.id': message.id,
        },
      },
      () => this.handle(session, message),
    ).catch((err: unknown) => {
      this.deps.log.error(
        { err, userId: session.userId, matchId: message.matchId, type: message.type },
        'falló un mensaje de WebSocket',
      );
      session.error(message.id, 'INTERNAL', 'Error interno; vuelve a intentar', true);
    });
  }

  private async handle(session: Session, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'play_card': {
        const result = await this.deps.store.apply(
          message.matchId,
          { type: 'play_card', playerId: session.userId, cardId: message.payload.cardId },
          { moveId: message.id, actorId: session.userId, expectedSeq: message.expectedSeq },
        );
        this.reply(session, message, result);
        return;
      }
      case 'leave_match': {
        const result = await this.deps.store.apply(
          message.matchId,
          { type: 'abandon', playerId: session.userId },
          { moveId: message.id, actorId: session.userId },
        );
        this.reply(session, message, result);
        return;
      }
      case 'resume': {
        if (!(await this.deps.matches.isParticipant(message.matchId, session.userId))) {
          session.error(message.id, 'MATCH_NOT_FOUND', 'La partida no existe');
          return;
        }
        session.enqueue(() => this.attachToMatch(session, message.matchId));
        return;
      }
    }
  }

  private reply(session: Session, message: ClientMessage, result: ApplyResult): void {
    const { id } = message;
    // Una línea por jugada, con la partida y el jugador; dentro de la traza del mensaje.
    this.deps.log.info(
      {
        matchId: message.matchId,
        userId: session.userId,
        type: message.type,
        outcome: result.kind,
        seq: result.seq,
        ...(result.kind === 'rejected' && { code: result.code }),
      },
      'jugada',
    );
    switch (result.kind) {
      case 'applied': {
        session.send({ v: PROTOCOL_VERSION, type: 'ack', id, seq: result.seq, duplicate: false });
        return;
      }
      case 'duplicate': {
        session.send({ v: PROTOCOL_VERSION, type: 'ack', id, seq: result.seq, duplicate: true });
        return;
      }
      case 'rejected': {
        session.error(id, toErrorCode(result.code), result.message, result.code === 'STALE_STATE');
        return;
      }
    }
  }

  // --- Reparto de eventos --------------------------------------------------------------------

  /** Engancha la conexión a una partida y le manda su estado visible. */
  private async attachToMatch(session: Session, matchId: string): Promise<void> {
    if (session.isClosed()) return;
    if (session.matchId !== matchId) {
      await this.removeFromMatch(session);
      session.matchId = matchId;
      let sessions = this.byMatch.get(matchId);
      if (sessions === undefined) {
        sessions = new Set();
        this.byMatch.set(matchId, sessions);
        // Primero se suscribe y después se lee el estado: un evento que llegue en medio queda
        // en la cola de la conexión y se descarta si el snapshot ya lo incluía.
        await this.deps.subscriber.subscribe(matchChannel(matchId), this.onMatchMessage);
      }
      sessions.add(session);
      if (session.isClosed()) return this.removeFromMatch(session);
    }
    const loaded = await this.deps.store.load(matchId);
    if (loaded === undefined) return;
    session.lastSeq = loaded.row.seq;
    session.send({
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      matchId,
      seq: loaded.row.seq,
      view: viewFor(loaded.state, session.userId),
    });
  }

  /** Manda los eventos que la conexión no tiene, en orden y sin huecos. */
  private async deliver(
    session: Session,
    matchId: string,
    events: readonly SequencedEvent[],
    publishedAt?: number,
  ): Promise<void> {
    if (session.matchId !== matchId) return;
    let sent = false;
    for (const { seq, event } of [...events].sort((a, b) => a.seq - b.seq)) {
      if (seq <= session.lastSeq) continue;
      if (seq > session.lastSeq + 1) {
        // Faltan eventos (un aviso se perdió o llegó desordenado): se leen de Postgres.
        const missing = await this.deps.store.eventsBetween(matchId, session.lastSeq, seq - 1);
        for (const m of missing) this.sendEvent(session, matchId, m);
      }
      sent = this.sendEvent(session, matchId, { seq, event }) || sent;
    }
    if (sent && publishedAt !== undefined) this.metrics.eventDelivered(Date.now() - publishedAt);
  }

  private sendEvent(session: Session, matchId: string, { seq, event }: SequencedEvent): boolean {
    if (seq !== session.lastSeq + 1) return false;
    session.lastSeq = seq;
    session.send({ v: PROTOCOL_VERSION, type: 'event', matchId, seq, event: projectEvent(event, session.userId) });
    return true;
  }

  private readonly onMatchMessage = (raw: string): void => {
    let message: MatchEventsMessage;
    try {
      message = JSON.parse(raw) as MatchEventsMessage;
    } catch {
      return;
    }
    const sessions = this.byMatch.get(message.matchId);
    if (sessions === undefined) return;
    for (const session of sessions) {
      session.enqueue(() => this.deliver(session, message.matchId, message.events, message.publishedAt));
    }
  };

  private readonly onUserMessage = (raw: string, channel: string): void => {
    let message: UserMessage;
    try {
      message = JSON.parse(raw) as UserMessage;
    } catch {
      return;
    }
    const userId = channel.slice(userChannel('').length);
    for (const session of this.byUser.get(userId) ?? []) {
      switch (message.type) {
        case 'assigned': {
          const { matchId } = message;
          session.enqueue(() => this.attachToMatch(session, matchId));
          break;
        }
        case 'suspended':
          session.close(4003, 'La cuenta fue suspendida');
          break;
      }
    }
  };

  private async addUserSession(session: Session): Promise<void> {
    let sessions = this.byUser.get(session.userId);
    if (sessions === undefined) {
      sessions = new Set();
      this.byUser.set(session.userId, sessions);
      await this.deps.subscriber.subscribe(userChannel(session.userId), this.onUserMessage);
    }
    sessions.add(session);
  }

  private async removeUserSession(session: Session): Promise<void> {
    const sessions = this.byUser.get(session.userId);
    if (sessions === undefined) return;
    sessions.delete(session);
    if (sessions.size === 0) {
      this.byUser.delete(session.userId);
      await this.deps.subscriber.unsubscribe(userChannel(session.userId), this.onUserMessage).catch(() => undefined);
    }
  }

  private async removeFromMatch(session: Session): Promise<void> {
    const matchId = session.matchId;
    if (matchId === null) return;
    session.matchId = null;
    const sessions = this.byMatch.get(matchId);
    if (sessions === undefined) return;
    sessions.delete(session);
    if (sessions.size === 0) {
      this.byMatch.delete(matchId);
      await this.deps.subscriber.unsubscribe(matchChannel(matchId), this.onMatchMessage).catch(() => undefined);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const sessions of this.byUser.values()) {
      for (const session of sessions) {
        if (now - session.lastPong > this.deps.options.heartbeatTimeoutMs) {
          session.close(4000, 'No respondió al heartbeat');
        } else if (session.socket.readyState === session.socket.OPEN) {
          session.socket.ping();
        }
      }
    }
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function extractId(raw: unknown): string | null {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'id' in raw &&
    typeof raw.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(raw.id)
  ) {
    return raw.id;
  }
  return null;
}

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};
const PROBLEM_TYPE: Record<number, string> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  500: 'internal',
  503: 'not-ready',
};

/** Rechaza el handshake con una respuesta HTTP en Problem Details y cierra el socket. */
function reject(socket: Duplex, status: number, detail: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({
    type: `/problems/${PROBLEM_TYPE[status] ?? 'internal'}`,
    title: STATUS_TEXT[status] ?? 'Error',
    status,
    detail,
  });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/problem+json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
