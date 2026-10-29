import { MatchResultSchema, PlayerEventSchema, PlayerViewSchema } from '@arenal/contracts';
import { z } from 'zod';

/**
 * Esquemas de la API REST. Son la única fuente de verdad: validan las solicitudes, tipan
 * los handlers y generan el contrato OpenAPI 3.1 publicado en /docs.
 */
const named = <T extends z.ZodType>(id: string, schema: T): T => {
  z.globalRegistry.add(schema, { id });
  return schema;
};

export const Problem = named(
  'Problem',
  z
    .looseObject({
      type: z.string().describe('Referencia al tipo de error; ver docs/problems.md'),
      title: z.string(),
      status: z.int(),
      detail: z.string().optional(),
      instance: z.string().optional(),
      code: z.string().optional().describe('Código estable para distinguir casos con el mismo estado HTTP'),
    })
    .describe('Error en formato RFC 9457 (application/problem+json)'),
);

export const Uuid = z.uuid();
export const IdParams = z.object({ id: Uuid });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional().describe('Cursor opaco devuelto en nextCursor'),
});

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable().describe('null si no hay más páginas') });

// --- Usuarios ------------------------------------------------------------------------------

const Email = z.email().max(254);
const Password = z.string().min(10, 'Mínimo 10 caracteres').max(128, 'Máximo 128 caracteres');
const DisplayName = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'Solo letras, números, espacios y _ . -');

export const RegisterBody = z.object({ email: Email, password: Password, displayName: DisplayName }).strict();
export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(128) }).strict();
export const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) }).strict();
export const UpdateProfileBody = z.object({ displayName: DisplayName }).strict();

export const Profile = named(
  'Profile',
  z.object({
    id: Uuid,
    email: z.string(),
    displayName: z.string(),
    role: z.enum(['player', 'admin']),
    createdAt: z.iso.datetime(),
  }),
);

export const Session = named(
  'Session',
  z.object({
    user: Profile,
    accessToken: z.string().describe('JWT ES256; va en el encabezado Authorization: Bearer'),
    refreshToken: z.string().describe('Opaco y de un solo uso: cada renovación entrega uno nuevo'),
    tokenType: z.literal('Bearer'),
    expiresIn: z.int().describe('Segundos de vida del access token'),
  }),
);

// --- Salas y cola --------------------------------------------------------------------------

export const CreateRoomBody = z
  .object({
    visibility: z.enum(['public', 'private']),
    capacity: z.int().min(2).max(5).default(4),
  })
  .strict();

export const JoinByCodeBody = z.object({ inviteCode: z.string().trim().min(8).max(8) }).strict();
export const ReadyBody = z.object({ ready: z.boolean() }).strict();

export const Room = named(
  'Room',
  z.object({
    id: Uuid,
    visibility: z.enum(['public', 'private']),
    inviteCode: z.string().nullable().describe('Solo visible para los miembros de la sala'),
    capacity: z.int(),
    status: z.enum(['waiting', 'started', 'closed']),
    hostId: Uuid,
    members: z.array(z.object({ userId: Uuid, displayName: z.string(), ready: z.boolean() })),
    matchId: Uuid.nullable().describe('La partida creada cuando la sala arrancó'),
    createdAt: z.iso.datetime(),
  }),
);

export const RoomListing = named(
  'RoomListing',
  z.object({
    id: Uuid,
    capacity: z.int(),
    memberCount: z.int(),
    hostDisplayName: z.string(),
    createdAt: z.iso.datetime(),
  }),
);
export const RoomPage = pageOf(RoomListing);

export const TicketStatus = named(
  'TicketStatus',
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('idle') }),
    z.object({ state: z.literal('waiting'), waitedMs: z.int(), maxWaitMs: z.int() }),
    z.object({ state: z.literal('matched'), matchId: Uuid }),
    z.object({ state: z.literal('expired') }),
  ]),
);

// --- Tiempo real ---------------------------------------------------------------------------

export const RealtimeTicket = named(
  'RealtimeTicket',
  z.object({
    ticket: z.string().describe('Se manda como ?ticket=… al abrir el WebSocket; sirve una sola vez'),
    expiresIn: z.int().describe('Segundos de vida del ticket'),
    path: z.string().describe('Ruta del WebSocket'),
  }),
);

// --- Partidas ------------------------------------------------------------------------------

// Los mismos esquemas del protocolo en tiempo real: la vista de REST y la de WebSocket no
// pueden diferir. Además, al validar la respuesta se descarta cualquier campo que no esté
// en el esquema, una segunda barrera contra filtrar información oculta.
export const PlayerView = named('PlayerView', PlayerViewSchema);
export const PlayerEvent = named('PlayerEvent', PlayerEventSchema);
const MatchResult = named('MatchResult', MatchResultSchema);

export const MatchSummary = named(
  'MatchSummary',
  z.object({
    matchId: Uuid,
    origin: z.enum(['room', 'matchmaking']),
    status: z.enum(['playing', 'finished', 'aborted']),
    players: z.array(z.object({ id: Uuid, displayName: z.string() })),
    result: MatchResult.nullable(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  }),
);
export const MatchPage = pageOf(MatchSummary);

export const MatchSnapshot = named(
  'MatchSnapshot',
  z.object({
    matchId: Uuid,
    seq: z.int(),
    view: PlayerView,
  }),
);

export const MatchReplay = named(
  'MatchReplay',
  z.object({
    matchId: Uuid,
    events: z.array(z.object({ seq: z.int(), event: PlayerEvent })),
  }),
);

// --- Administración ------------------------------------------------------------------------

export const AdminActionBody = z
  .object({ reason: z.string().trim().min(3).max(500).describe('Motivo de la acción; queda en la auditoría') })
  .strict();

export const AuditQuery = PageQuery.extend({
  targetId: Uuid.optional().describe('Solo las acciones sobre esta partida o este usuario'),
});

export const AdminMatch = named(
  'AdminMatch',
  z
    .object({
      matchId: Uuid,
      origin: z.enum(['room', 'matchmaking']),
      seq: z.int(),
      turn: z.int(),
      currentPlayer: Uuid.nullable(),
      turnDeadline: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
      players: z.array(
        z.object({
          id: Uuid,
          displayName: z.string(),
          inGame: z.boolean().describe('false si ya quedó eliminado'),
          connections: z.int().describe('Conexiones WebSocket abiertas en todas las réplicas'),
          disconnectedAt: z.iso.datetime().nullable().describe('Desde cuándo no tiene conexiones; corre la gracia'),
        }),
      ),
    })
    .describe('Partida en curso. Solo datos públicos: ni manos, ni mazo, ni límite.'),
);
export const AdminMatchPage = pageOf(AdminMatch);

export const ConnectionsOverview = named(
  'ConnectionsOverview',
  z.object({
    total: z.int().describe('Conexiones abiertas en todas las réplicas'),
    truncated: z.boolean().describe('true si hay más conexiones de las listadas (máximo 1000)'),
    replicas: z.array(z.object({ replica: z.string(), connections: z.int() })),
    users: z.array(
      z.object({ userId: Uuid, displayName: z.string(), connections: z.int(), activeMatchId: Uuid.nullable() }),
    ),
  }),
);

export const AdminUser = named(
  'AdminUser',
  z.object({
    id: Uuid,
    email: z.string(),
    displayName: z.string(),
    role: z.enum(['player', 'admin']),
    createdAt: z.iso.datetime(),
    suspendedAt: z.iso.datetime().nullable(),
    activeMatchId: Uuid.nullable(),
    connections: z.int(),
  }),
);

export const TerminatedMatch = named(
  'TerminatedMatch',
  z.object({ matchId: Uuid, seq: z.int().describe('Secuencia del evento MatchEnded'), status: z.literal('aborted') }),
);

export const AuditEntry = named(
  'AuditEntry',
  z.object({
    id: Uuid,
    actor: z
      .object({ id: Uuid, displayName: z.string() })
      .nullable()
      .describe('null si la acción vino de la línea de comandos'),
    action: z.enum(['match.terminate', 'user.suspend', 'user.reinstate', 'user.grant_admin', 'user.revoke_admin']),
    targetType: z.enum(['match', 'user']),
    targetId: Uuid,
    reason: z.string(),
    details: z.record(z.string(), z.unknown()),
    requestId: z.string().nullable().describe('ID de la solicitud, para cruzar con los logs'),
    createdAt: z.iso.datetime(),
  }),
);
export const AuditPage = pageOf(AuditEntry);

/** Respuestas de error comunes para documentar en cada ruta. */
export const errors = (...codes: (400 | 401 | 403 | 404 | 409 | 429)[]) =>
  Object.fromEntries(codes.map((c) => [c, Problem])) as Record<number, typeof Problem>;
