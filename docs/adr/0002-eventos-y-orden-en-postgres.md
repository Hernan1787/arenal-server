# 0002 — El dominio decide con eventos y Postgres ordena las jugadas

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

Varias réplicas pueden recibir jugadas de la misma partida. Las jugadas deben procesarse una a la vez, sin
perderse ni duplicarse, y la partida debe sobrevivir al reinicio de una réplica y poder repetirse jugada por
jugada.

## Decisión

1. El dominio expone tres funciones puras: `decide(estado, intención) → eventos`, `evolve(estado, evento) →
   estado` y `viewFor(estado, jugador) → vista`. El azar queda registrado dentro de los eventos.
2. Cada jugada se procesa en una transacción de Postgres que bloquea la fila de la partida (`SELECT … FOR
   UPDATE`), compara el `expectedSeq` del cliente con la versión actual y guarda los eventos nuevos. La tabla de
   eventos tiene `UNIQUE (match_id, move_id)` para la idempotencia.
3. Después del commit, el evento se publica en Redis; cada réplica lo filtra con `projectEvent` para cada
   jugador conectado a ella.

## Consecuencias

- Cualquier réplica puede atender cualquier partida; no hace falta afinidad de sesión.
- La partida se reconstruye con `replay(estadoInicial, eventos)`; una prueba lo verifica en 150 partidas al azar.
- Cada jugada cuesta una transacción en Postgres. Es probable que el cuello de botella de la prueba de carga
  sea la base de datos (un B1ms con créditos de CPU), así que el reporte de carga debe medir también su CPU.
