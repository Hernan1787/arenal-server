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

export interface RoomMember {
  readonly userId: string;
  readonly displayName: string;
  readonly ready: boolean;
}

export interface Room {
  readonly id: string;
  readonly inviteCode: string | null;
  readonly status: 'waiting' | 'started' | 'closed';
  readonly matchId: string | null;
  readonly capacity?: number;
  readonly hostId?: string;
  readonly members?: readonly RoomMember[];
}

export interface MatchSummary {
  readonly matchId: string;
  readonly status: 'playing' | 'finished' | 'aborted';
  readonly players: readonly { readonly id: string; readonly displayName: string }[];
}

export type TicketStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly waitedMs: number; readonly maxWaitMs: number }
  | { readonly state: 'matched'; readonly matchId: string }
  | { readonly state: 'expired' };

/** Cliente de la API REST. Un objeto por usuario: guarda su sesión y la renueva cuando vence. */
export class ArenalApi {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  get userToken(): string | null {
    return this.token;
  }

  async register(input: { email: string; password: string; displayName: string }): Promise<Session> {
    return this.keep(await this.request<Session>('POST', '/v1/auth/register', input, false));
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    return this.keep(await this.request<Session>('POST', '/v1/auth/login', input, false));
  }

  /**
   * Cambia el refresh token por una sesión nueva. Se llama sola cuando el access token vence (dura
   * unos minutos); si varias solicitudes se dan cuenta a la vez, se renueva una sola vez.
   */
  refresh(): Promise<void> {
    const refreshToken = this.refreshToken;
    if (refreshToken === null) return Promise.reject(new Error('No hay sesión que renovar'));
    this.refreshing ??= this.request<Session>('POST', '/v1/auth/refresh', { refreshToken }, false)
      .then((session) => {
        this.keep(session);
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
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

  getRoom(roomId: string): Promise<Room> {
    return this.request('GET', `/v1/rooms/${roomId}`);
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.request('POST', `/v1/rooms/${roomId}/leave`);
  }

  enqueue(): Promise<TicketStatus> {
    return this.request('POST', '/v1/matchmaking/ticket');
  }

  ticketStatus(): Promise<TicketStatus> {
    return this.request('GET', '/v1/matchmaking/ticket');
  }

  async leaveQueue(): Promise<void> {
    await this.request('DELETE', '/v1/matchmaking/ticket');
  }

  /** Mis partidas, de la más nueva a la más vieja (trae los nombres de los jugadores). */
  async myMatches(limit = 5): Promise<readonly MatchSummary[]> {
    const page = await this.request<{ items: MatchSummary[] }>('GET', `/v1/me/matches?limit=${limit}`);
    return page.items;
  }

  /** Ticket de un solo uso para abrir el WebSocket. */
  async realtimeTicket(): Promise<string> {
    const { ticket } = await this.request<{ ticket: string }>('POST', '/v1/realtime/tickets');
    return ticket;
  }

  private keep(session: Session): Session {
    this.token = session.accessToken;
    this.refreshToken = session.refreshToken;
    return session;
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
    const token = this.token;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (token === null) throw new Error('Primero hay que registrarse o iniciar sesión');
      headers['authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    if (res.status === 401 && auth && !retried && this.refreshToken !== null) {
      // Access token vencido: se renueva (si otra solicitud no lo hizo ya) y se intenta una vez más.
      if (this.token === token) await this.refresh();
      return this.request<T>(method, path, body, true, true);
    }
    if (!res.ok) throw new ApiError(res.status, parsed ?? {});
    return parsed as T;
  }
}
