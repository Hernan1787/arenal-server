// Todo lo del cliente que funciona igual en Node y en el navegador.
export {
  ApiError,
  ArenalApi,
  type MatchSummary,
  type Room,
  type RoomMember,
  type Session,
  type TicketStatus,
} from './api.js';
export { cardName, describeEvent } from './describe.js';
export {
  RealtimeSession,
  RejectedError,
  useWebSocket,
  type Ack,
  type RealtimeHandlers,
  type ServerError,
  type WebSocketFactory,
  type WebSocketLike,
} from './realtime.js';
export { ReconnectingSession, type ReconnectOptions } from './reconnecting.js';
export { chooseCard, isMyTurn } from './strategy.js';
