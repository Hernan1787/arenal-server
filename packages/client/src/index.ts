// Entrada para Node (bot, cliente de terminal, prueba de carga y pruebas): el WebSocket de la
// librería `ws`, que siempre usa HTTP/1.1 (ver RealtimeSession.open).
import WebSocket from 'ws';
import { useWebSocket } from './realtime.js';

useWebSocket((url) => new WebSocket(url));

export * from './shared.js';
