# 0007 — Tiempo real entre réplicas: Redis para avisar, Postgres para no perder nada

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

Los jugadores de una misma partida pueden estar conectados a réplicas distintas. Cada jugador debe recibir
todos los eventos de su partida, en orden, sin huecos ni repetidos, y filtrados para lo que puede ver. Los
temporizadores y el periodo de gracia tienen que funcionar aunque una réplica se reinicie.

## Decisión

- **Avisos por Redis pub/sub.** Después de confirmar una jugada en Postgres, la réplica publica los eventos en el
  canal de la partida. Cada réplica se suscribe solo a las partidas de sus conexiones y filtra cada evento con
  `projectEvent` para cada jugador. Al crearse una partida se avisa por el canal de cada jugador, así quien está
  conectado recibe el snapshot sin consultar.
- **Orden y huecos por conexión.** Cada conexión recuerda el último `seq` que mandó y procesa sus entregas en
  una cola propia. Un evento ya enviado se descarta; si llega uno con un hueco antes (un aviso perdido o
  desordenado), la réplica lee los que faltan de Postgres y los manda primero. Pub/sub puede perder mensajes;
  Postgres no, así que el jugador nunca queda con un estado incompleto.
- **Handshake con ticket.** `POST /v1/realtime/tickets` entrega un ticket aleatorio de un solo uso que vive 30 s
  en Redis (solo su hash). La réplica lo consume con `GETDEL`, revisa el `Origin` y la cuenta, y recién entonces
  abre el socket.
- **Presencia en Redis con arriendo.** Cada conexión es un miembro de un sorted set con vencimiento que el
  heartbeat renueva. Cuando se cierra la última conexión de un jugador, se marca `disconnected_at` en Postgres.
  Si una réplica se cae sin cerrar sus conexiones, sus arriendos vencen y el barrido lo corrige.
- **Reloj del servidor en todas las réplicas.** Cada segundo, cada réplica busca turnos vencidos y jugadores
  desconectados más allá del periodo de gracia, y aplica la acción como una intención más. Si dos réplicas
  encuentran lo mismo, la transacción serializa y el dominio rechaza el segundo intento (`STALE_TIMER` o
  `PLAYER_ELIMINATED`).

## Consecuencias

- No hace falta afinidad de sesión ni elegir una réplica líder.
- Al apagarse, una réplica cierra sus conexiones con 1012; los clientes reconectan a otra y reciben el estado
  actual con su snapshot.
- Cada barrido hace un par de consultas indexadas aunque no haya nada vencido. Con muchas réplicas convendría
  un candado de Postgres para que solo una barra; para este proyecto el costo es despreciable.
