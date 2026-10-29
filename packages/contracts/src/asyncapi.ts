import { z } from 'zod';
import {
  AckMessage,
  CLOSE_CODES,
  ERROR_CODES,
  ErrorMessage,
  EventMessage,
  LeaveMatchMessage,
  MAX_CLIENT_MESSAGE_BYTES,
  PlayCardMessage,
  PROTOCOL_VERSION,
  ResumeMessage,
  SnapshotMessage,
} from './realtime.js';

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Json {
  const json: Json = { ...z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) };
  delete json['$schema'];
  return json;
}

/** Ejemplos de cada mensaje. Las pruebas verifican que todos pasen su esquema. */
export const EXAMPLES = {
  PlayCard: {
    v: 1,
    type: 'play_card',
    id: '0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d0e',
    matchId: 'm_01jbx4',
    expectedSeq: 41,
    payload: { cardId: 'c_8f3k2a' },
  },
  Resume: { v: 1, type: 'resume', id: '0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d0f', matchId: 'm_01jbx4', lastSeq: 38 },
  LeaveMatch: { v: 1, type: 'leave_match', id: '0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d10', matchId: 'm_01jbx4' },
  Ack: { v: 1, type: 'ack', id: '0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d0e', seq: 44, duplicate: false },
  Event: {
    v: 1,
    type: 'event',
    matchId: 'm_01jbx4',
    seq: 42,
    event: {
      type: 'CardPlayed',
      playerId: 'u_ana',
      card: { id: 'c_8f3k2a', kind: 'stone', value: 3 },
      pressureAfter: 17,
      auto: false,
    },
  },
  Snapshot: {
    v: 1,
    type: 'snapshot',
    matchId: 'm_01jbx4',
    seq: 44,
    view: {
      matchId: 'm_01jbx4',
      status: 'playing',
      version: 44,
      round: 2,
      turn: 9,
      currentPlayer: 'u_beto',
      pressure: 17,
      lastRevealedLimit: 19,
      drawPileCount: 27,
      discardCount: 9,
      players: [
        { id: 'u_ana', seat: 0, lives: 3, handCount: 4, eliminated: false, eliminationReason: null },
        { id: 'u_beto', seat: 1, lives: 2, handCount: 4, eliminated: false, eliminationReason: null },
      ],
      you: {
        id: 'u_ana',
        hand: [
          { id: 'c_0k2m9z', kind: 'stone', value: 1 },
          { id: 'c_7xq1aa', kind: 'cool' },
          { id: 'c_p3r8dd', kind: 'seismo' },
          { id: 'c_9vb2ee', kind: 'stone', value: 4 },
        ],
        seismo: null,
      },
      rules: {
        startingLives: 3,
        handSize: 4,
        limitMin: 15,
        limitMax: 25,
        coolAmount: 3,
        seismoThreshold: 4,
        maxRounds: 15,
      },
      result: null,
    },
  },
  Error: {
    v: 1,
    type: 'error',
    id: '0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d0e',
    code: 'NOT_YOUR_TURN',
    message: 'No es tu turno',
    retryable: false,
  },
} as const;

const MESSAGES = {
  PlayCard: { schema: PlayCardMessage, title: 'Jugar una carta', direction: 'cliente → servidor' },
  Resume: { schema: ResumeMessage, title: 'Reanudar', direction: 'cliente → servidor' },
  LeaveMatch: { schema: LeaveMatchMessage, title: 'Salir de la partida', direction: 'cliente → servidor' },
  Ack: { schema: AckMessage, title: 'Confirmación', direction: 'servidor → cliente' },
  Event: { schema: EventMessage, title: 'Evento de la partida', direction: 'servidor → cliente' },
  Snapshot: { schema: SnapshotMessage, title: 'Estado visible', direction: 'servidor → cliente' },
  Error: { schema: ErrorMessage, title: 'Error', direction: 'servidor → cliente' },
} as const;

type MessageName = keyof typeof MESSAGES;

const msgRef = (name: MessageName): Json => ({ $ref: `#/channels/realtime/messages/${name}` });

/** Construye el contrato AsyncAPI 3.0 del protocolo en tiempo real a partir de los esquemas Zod. */
export function buildAsyncApiDocument(version: string): Json {
  const names = Object.keys(MESSAGES) as MessageName[];

  const componentMessages: Json = {};
  const componentSchemas: Json = {};
  for (const name of names) {
    const { schema, title, direction } = MESSAGES[name];
    componentSchemas[name] = jsonSchema(schema);
    componentMessages[name] = {
      name,
      title,
      summary: `${direction}. ${schema.description ?? ''}`.trim(),
      contentType: 'application/json',
      payload: { $ref: `#/components/schemas/${name}` },
      examples: [{ name: `${name}Ejemplo`, payload: EXAMPLES[name] }],
    };
  }

  const closeCodes = Object.entries(CLOSE_CODES)
    .map(([code, meaning]) => `- **${code}**: ${meaning}`)
    .join('\n');

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'Arenal — protocolo en tiempo real',
      version,
      description: [
        `Protocolo WebSocket del servidor de Arenal, versión ${PROTOCOL_VERSION}.`,
        '',
        'La conexión se autentica en el handshake con un ticket de un solo uso que dura 30 segundos',
        '(se pide con `POST /v1/realtime/tickets`). Si el handshake no pasa, el servidor responde por HTTP en',
        'Problem Details y no abre el socket: 401 sin ticket válido, 403 con un `Origin` no permitido o una cuenta',
        'suspendida, 503 si la réplica se está apagando.',
        '',
        'Al conectarse, el servidor manda un `snapshot` de la partida en curso del jugador, si tiene una. Si se le',
        'asigna una partida estando conectado (una sala que arranca o la cola), también recibe su `snapshot`.',
        'Después llegan los `event` de esa partida con `seq` consecutivos; el servidor rellena cualquier hueco antes',
        'de seguir. Si el cliente pierde la conexión, reconecta con un ticket nuevo y recibe el estado actual.',
        '',
        'Límites: 3 conexiones por usuario (la cuarta se cierra con 4029) y 10 mensajes por segundo con ráfagas de 20',
        '(los excedentes reciben `RATE_LIMITED`).',
        `Cada mensaje del cliente pesa como máximo ${MAX_CLIENT_MESSAGE_BYTES} bytes y se valida contra su esquema.`,
        'El servidor manda ping cada 15 segundos; si no recibe pong en 30, cierra con 4000.',
        '',
        '**Códigos de cierre**',
        '',
        closeCodes,
        '',
        '**Códigos de error**: ' + ERROR_CODES.map((c) => `\`${c}\``).join(', '),
      ].join('\n'),
    },
    servers: {
      local: {
        host: 'localhost:8080',
        protocol: 'ws',
        pathname: '/v1/realtime',
        description: 'docker compose up',
        security: [{ $ref: '#/components/securitySchemes/ticket' }],
      },
      azure: {
        host: '{appFqdn}',
        protocol: 'wss',
        pathname: '/v1/realtime',
        description: 'Azure Container Apps',
        variables: { appFqdn: { description: 'Dominio de la app en Azure Container Apps' } },
        security: [{ $ref: '#/components/securitySchemes/ticket' }],
      },
    },
    channels: {
      realtime: {
        address: '/v1/realtime',
        title: 'Conexión en tiempo real',
        messages: Object.fromEntries(names.map((n) => [n, { $ref: `#/components/messages/${n}` }])),
      },
    },
    operations: {
      playCard: {
        action: 'receive',
        channel: { $ref: '#/channels/realtime' },
        summary: 'El jugador de turno juega una carta.',
        messages: [msgRef('PlayCard')],
        reply: { channel: { $ref: '#/channels/realtime' }, messages: [msgRef('Ack'), msgRef('Error')] },
      },
      resume: {
        action: 'receive',
        channel: { $ref: '#/channels/realtime' },
        summary: 'El cliente pide los eventos que le faltan.',
        messages: [msgRef('Resume')],
        reply: { channel: { $ref: '#/channels/realtime' }, messages: [msgRef('Snapshot'), msgRef('Error')] },
      },
      leaveMatch: {
        action: 'receive',
        channel: { $ref: '#/channels/realtime' },
        summary: 'El jugador abandona la partida.',
        messages: [msgRef('LeaveMatch')],
        reply: { channel: { $ref: '#/channels/realtime' }, messages: [msgRef('Ack'), msgRef('Error')] },
      },
      sendEvent: {
        action: 'send',
        channel: { $ref: '#/channels/realtime' },
        summary: 'El servidor reparte cada evento confirmado, filtrado para cada jugador.',
        messages: [msgRef('Event')],
      },
      sendSnapshot: {
        action: 'send',
        channel: { $ref: '#/channels/realtime' },
        summary: 'Estado visible al conectarse.',
        messages: [msgRef('Snapshot')],
      },
    },
    components: {
      securitySchemes: {
        ticket: {
          type: 'httpApiKey',
          name: 'ticket',
          in: 'query',
          description: 'Ticket aleatorio de un solo uso que vence en 30 segundos.',
        },
      },
      messages: componentMessages,
      schemas: componentSchemas,
    },
  };
}
