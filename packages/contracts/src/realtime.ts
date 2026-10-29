import { z } from 'zod';

/** Versión del protocolo. Un mensaje con otra versión se rechaza con `UNSUPPORTED_VERSION`. */
export const PROTOCOL_VERSION = 1;

/** Tamaño máximo de un mensaje entrante, en bytes. El servidor cierra con 1009 si se pasa. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

const MessageId = z
  .uuid()
  .describe('ID generado por el cliente. Si reenvía el mismo ID, la jugada no se aplica dos veces.');
const MatchId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const PlayerId = z.string().min(1).max(64);
const CardId = z
  .string()
  .regex(/^c_[0-9a-z]{6}$/)
  .describe('ID opaco de la carta, distinto en cada partida.');
const Seq = z.int().min(0).describe('Número de secuencia del último evento de la partida.');

// --- Cartas y estado público ------------------------------------------------------------

export const CardSchema = z.discriminatedUnion('kind', [
  z.object({
    id: CardId,
    kind: z.literal('stone'),
    value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
  z.object({ id: CardId, kind: z.literal('cool') }),
  z.object({ id: CardId, kind: z.literal('seismo') }),
]);

const EliminationReason = z.enum(['lives', 'abandon']);

export const MatchResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('winner'), winner: PlayerId, reason: z.enum(['last_standing', 'most_lives']) }),
  z.object({ kind: z.literal('draw'), players: z.array(PlayerId), reason: z.enum(['tied_lives', 'no_players']) }),
]);

export const PlayerViewSchema = z
  .object({
    matchId: MatchId,
    status: z.enum(['waiting', 'playing', 'finished']),
    version: Seq,
    round: z.int().min(0),
    turn: z.int().min(0),
    currentPlayer: PlayerId.nullable(),
    pressure: z.int().min(0),
    lastRevealedLimit: z.int().nullable(),
    drawPileCount: z.int().min(0),
    discardCount: z.int().min(0),
    players: z.array(
      z.object({
        id: PlayerId,
        seat: z.int().min(0),
        lives: z.int().min(0),
        handCount: z.int().min(0),
        eliminated: z.boolean(),
        eliminationReason: EliminationReason.nullable(),
      }),
    ),
    you: z
      .object({
        id: PlayerId,
        hand: z.array(CardSchema),
        seismo: z.object({ near: z.boolean() }).nullable(),
      })
      .nullable(),
    rules: z.object({
      startingLives: z.int(),
      handSize: z.int(),
      limitMin: z.int(),
      limitMax: z.int(),
      coolAmount: z.int(),
      seismoThreshold: z.int(),
      maxRounds: z.int(),
    }),
    result: MatchResultSchema.nullable(),
  })
  .describe('Lo que un jugador puede ver de la partida. Nunca incluye el límite secreto ni el mazo.');

export const PlayerEventSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('MatchStarted'), playerOrder: z.array(PlayerId) }),
    z.object({ type: z.literal('DeckShuffled'), count: z.int().min(0) }),
    z.object({ type: z.literal('CardDrawn'), playerId: PlayerId, card: CardSchema.optional() }),
    z.object({ type: z.literal('RoundStarted'), round: z.int().min(1), firstPlayer: PlayerId }),
    z.object({ type: z.literal('TurnStarted'), playerId: PlayerId, turn: z.int().min(1) }),
    z.object({
      type: z.literal('CardPlayed'),
      playerId: PlayerId,
      card: CardSchema,
      pressureAfter: z.int().min(0),
      auto: z.boolean(),
    }),
    z.object({ type: z.literal('SeismoRead'), playerId: PlayerId, near: z.boolean().optional() }),
    z.object({ type: z.literal('Eruption'), playerId: PlayerId, limit: z.int(), livesLeft: z.int().min(0) }),
    z.object({
      type: z.literal('PlayerEliminated'),
      playerId: PlayerId,
      reason: EliminationReason,
      discardedCount: z.int().min(0),
    }),
    z.object({ type: z.literal('DiscardReshuffled'), count: z.int().min(0) }),
    z.object({ type: z.literal('MatchEnded'), result: MatchResultSchema }),
  ])
  .describe('Evento de la partida ya filtrado para quien lo recibe.');

// --- Mensajes del cliente ------------------------------------------------------------------

const clientEnvelope = { v: z.literal(PROTOCOL_VERSION), id: MessageId, matchId: MatchId };

export const PlayCardMessage = z
  .object({
    ...clientEnvelope,
    type: z.literal('play_card'),
    expectedSeq: Seq.describe('Último `seq` que vio el cliente. Si la partida avanzó, se rechaza con STALE_STATE.'),
    payload: z.object({ cardId: CardId }).strict(),
  })
  .strict()
  .describe('Intención de jugar una carta de la mano. Solo la acepta el servidor si es tu turno.');

export const ResumeMessage = z
  .object({
    ...clientEnvelope,
    type: z.literal('resume'),
    lastSeq: Seq.describe('Último `seq` recibido. El servidor manda los eventos que faltan o un snapshot.'),
  })
  .strict()
  .describe('Reengancharse a una partida después de una desconexión.');

export const LeaveMatchMessage = z
  .object({ ...clientEnvelope, type: z.literal('leave_match') })
  .strict()
  .describe('Salir de la partida. Cuenta como abandono.');

export const ClientMessage = z.discriminatedUnion('type', [PlayCardMessage, ResumeMessage, LeaveMatchMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- Mensajes del servidor -----------------------------------------------------------------

export const ERROR_CODES = [
  // Del dominio
  'NOT_A_PLAYER',
  'PLAYER_ELIMINATED',
  'NOT_YOUR_TURN',
  'CARD_NOT_IN_HAND',
  'MATCH_NOT_STARTED',
  'MATCH_FINISHED',
  // Del protocolo
  'INVALID_MESSAGE',
  'UNSUPPORTED_VERSION',
  'STALE_STATE',
  'MATCH_NOT_FOUND',
  'MOVE_ID_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const AckMessage = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('ack'),
    id: MessageId.describe('ID del mensaje del cliente que se confirma.'),
    seq: Seq.describe('Secuencia de la partida después de aplicar la jugada.'),
    duplicate: z.boolean().describe('`true` si el mensaje ya se había aplicado antes (reenvío).'),
  })
  .describe('La jugada quedó guardada en la base de datos.');

export const EventMessage = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('event'),
    matchId: MatchId,
    seq: z.int().min(1),
    event: PlayerEventSchema,
  })
  .describe(
    'Un evento nuevo de la partida. Los `seq` llegan seguidos; un hueco significa que hay que mandar `resume`.',
  );

export const SnapshotMessage = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('snapshot'),
    matchId: MatchId,
    seq: Seq,
    view: PlayerViewSchema,
  })
  .describe(
    'Estado completo visible para el jugador. Se manda al conectarse (si tiene una partida en curso), al responder un resume y cuando se le asigna una partida nueva estando conectado.',
  );

export const ErrorMessage = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('error'),
    id: MessageId.nullable().describe('ID del mensaje que causó el error, si se pudo leer.'),
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
  })
  .describe('Error tipado. Un mensaje inválido nunca cierra la partida.');

export const ServerMessage = z.discriminatedUnion('type', [AckMessage, EventMessage, SnapshotMessage, ErrorMessage]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Códigos de cierre de la conexión WebSocket. */
export const CLOSE_CODES = {
  1000: 'Cierre normal: el jugador salió de la partida.',
  1008: 'Violación de política.',
  1009: `Mensaje más grande que ${MAX_CLIENT_MESSAGE_BYTES} bytes.`,
  1012: 'La réplica se está reiniciando: reconectar y mandar resume.',
  4000: 'No respondió al heartbeat a tiempo.',
  4003: 'Cuenta suspendida o sin permiso para esta partida.',
  4029: 'Demasiadas conexiones o demasiados mensajes.',
} as const;

/** Devuelve el mensaje validado o la razón por la que no es válido. */
export function parseClientMessage(raw: unknown): { ok: true; message: ClientMessage } | { ok: false; reason: string } {
  const result = ClientMessage.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return { ok: false, reason: z.prettifyError(result.error) };
}
