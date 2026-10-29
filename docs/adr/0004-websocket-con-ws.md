# 0004 — WebSocket con `ws` en lugar de Socket.IO

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El tiempo real puede ir con WebSocket directo, SignalR, Socket.IO o Azure Web PubSub. El protocolo debe quedar
documentado en AsyncAPI 3.0, autenticarse en el handshake y tener heartbeat y códigos de cierre propios.

## Decisión

Usar la librería `ws` sobre el servidor HTTP de Fastify, con mensajes JSON versionados y validados con Zod.

## Consecuencias

- Control total del `upgrade` (ticket y `Origin` se validan antes de abrir el socket), de `maxPayload`, del
  ping/pong y de los códigos de cierre.
- El contrato AsyncAPI describe exactamente lo que viaja por el cable, sin el protocolo propio de Socket.IO.
- Reconexión, heartbeat y reparto entre réplicas hay que programarlos a mano; el reparto ya está resuelto con
  Redis (ADR 0002).
