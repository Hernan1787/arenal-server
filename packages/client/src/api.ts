/** Error de la API en formato Problem Details (RFC 9457). */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly problem: { readonly type?: string; readonly code?: string; readonly detail?: string },
  ) {
    super(`${status} ${problem.code ?? problem.type ?? ''}: ${problem.detail ?? 'error de la API'}`);
  }
}

export interface Session {
  readonly user: { readonly id: string; readonly displayName: string; readonly role: 'player' | 'admin' };
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface Room {
  readonly id: string;
  readonly inviteCode: string | null;
  readonly status: 'waiting' | 'started' | 'closed';
  readonly matchId: string | null;
}

export type TicketStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly waitedMs: number; readonly maxWaitMs: number }
  | { readonly state: 'matched'; readonly matchId: string }
  | { readonly state: 'expired' };

/** Cliente de la API REST. Un objeto por usuario: guarda su access token. */
export class ArenalApi {
  private token: string | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  get userToken(): string | null {
    return this.token;
  }

  async register(input: { email: string; password: string; displayName: string }): Promise<Session> {
    const session = await this.request<Session>('POST', '/v1/auth/register', input, false);
    this.token = session.accessToken;
    return session;
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    const session = await this.request<Session>('POST', '/v1/auth/login', input, false);
    this.token = session.accessToken;
    return session;
  }

  createRoom(input: { visibility: 'public' | 'private'; capacity?: number }): Promise<Room> {
    return this.request('POST', '/v1/rooms', input);
  }

  joinRoom(roomId: string): Promise<Room> {
    return this.request('POST', `/v1/rooms/${roomId}/join`);
  }

  joinByCode(inviteCode: string): Promise<Room> {
    return this.request('POST', '/v1/rooms/join-by-code', { inviteCode });
  }

  setReady(roomId: string, ready: boolean): Promise<Room> {
    return this.request('PUT', `/v1/rooms/${roomId}/ready`, { ready });
  }

  enqueue(): Promise<TicketStatus> {
    return this.request('POST', '/v1/matchmaking/ticket');
  }

  ticketStatus(): Promise<TicketStatus> {
    return this.request('GET', '/v1/matchmaking/ticket');
  }

  /** Ticket de un solo uso para abrir el WebSocket. */
  async realtimeTicket(): Promise<string> {
    const { ticket } = await this.request<{ ticket: string }>('POST', '/v1/realtime/tickets');
    return ticket;
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (this.token === null) throw new Error('Primero hay que registrarse o iniciar sesión');
      headers['authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    if (!res.ok) throw new ApiError(res.status, parsed ?? {});
    return parsed as T;
  }
}
