# 0010 — Caché del estado de las partidas en cada réplica

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

Con el ADR 0002, cada jugada reconstruía la partida desde cero: dentro de la transacción leía todos sus eventos de
Postgres, los parseaba y los volvía a aplicar con `replay`. Una partida de Arenal acumula entre 200 y 300 eventos,
así que la jugada número 100 leía y reprocesaba cientos de filas para agregar tres o cuatro. La prueba de carga
([load-test.md](../load-test.md)) lo confirmó como el costo principal por jugada.

## Decisión

Cada réplica guarda en memoria el último estado confirmado de las partidas que atiende (`StateCache`, LRU,
`STATE_CACHE_SIZE` partidas, 2000 por defecto). La regla que lo hace seguro con varias réplicas: **una entrada solo
se usa si su versión es exactamente el `seq` que se leyó con la fila de la partida bloqueada** (`FOR UPDATE`).

- Si otra réplica aplicó una jugada, el `seq` no coincide y se lee de Postgres como antes.
- El estado nuevo entra a la caché recién después del commit. Un estado más viejo nunca reemplaza a uno más nuevo.
- Las partidas terminadas salen de la caché.
- La lectura sin bloqueo (los snapshots) ahora pide los eventos hasta el `seq` de la fila. Así no mezcla una fila
  vieja con eventos que se confirmaron justo después.

Se descartó guardar el estado en Redis: es otra copia que mantener consistente, y la lectura por la red no ahorra
mucho frente a Postgres. Los snapshots periódicos en Postgres quedan como siguiente paso: ayudarían también a las réplicas que no
tienen la partida en caché, a cambio de una escritura extra cada tantas jugadas y una migración.

## Consecuencias

- Una jugada no lee eventos cuando la réplica que la recibe también procesó la anterior de esa partida. Con una
  réplica pasa siempre; con varias y el tráfico repartido al azar, más o menos una de cada N. Un fallo nunca cuesta
  más que antes. La métrica `arenal.state.loads` muestra la proporción real de aciertos.
- Memoria: un estado de Arenal ocupa unos pocos KB; 2000 partidas caben en unos pocos MB.
- La corrección no depende de la caché: con `STATE_CACHE_SIZE=0` el servidor se comporta exactamente como antes.
  Una prueba de integración alterna jugadas entre dos réplicas con caché y verifica que el estado coincide con el
  que se reconstruye desde Postgres.
