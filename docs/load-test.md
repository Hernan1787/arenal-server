# Prueba de carga

La herramienta está en [`apps/bot/src/load.ts`](../apps/bot/src/load.ts) (`pnpm load`). Juega partidas reales por
WebSocket con el mismo cliente que el bot ([`packages/client`](../packages/client)), y valida cada mensaje del
servidor contra el contrato.

## Qué mide

- **Latencia de punta a punta por jugada:** desde que el jugador manda la carta hasta que **todos** los jugadores de
  la mesa recibieron el último evento de esa jugada. Es la meta del enunciado: p95 < 200 ms.
- **Jugadas perdidas:** con `ack` del servidor pero sin su evento en algún jugador a los 10 s.
- **Duplicadas y huecos:** `ack` marcados como duplicados, y eventos cuyo `seq` no sigue al anterior.
- **Errores:** jugadas rechazadas que no son parte del protocolo, mensajes que no cumplen el contrato, conexiones
  cortadas, y salas que no arrancan. `STALE_STATE` no cuenta: es la respuesta esperada cuando el jugador juega
  sobre una versión que ya cambió.
- **CPU y memoria:** del proceso del servidor y de todos los procesos de Postgres, leídos de `/proc` cada segundo
  (solo Linux). 100 % es un núcleo completo.

Cada mesa juega partidas completas una tras otra durante la etapa. Los jugadores «piensan» 250 ms antes de cada
jugada, así que una partida de 2 hace unas 3 a 4 jugadas por segundo. Una etapa cumple si p95 < 200 ms, errores < 1 %
y ninguna jugada perdida ni hueco.

## Cómo correrla

```bash
# Servidor con límites de registro altos: la prueba crea cientos de usuarios desde una IP.
RATE_LIMIT_AUTH_PER_MINUTE=100000 RATE_LIMIT_TICKETS_PER_MINUTE=100000 RATE_LIMIT_USER_PER_MINUTE=100000 pnpm dev

pnpm load --ramp 50,100,200,300,400 --duration 45 --think 250 \
  --pid "$(pgrep -f 'src/main.ts' | head -1)" --db-pids auto
```

Cada corrida deja un JSON en `load/results/`. Las corridas de este reporte están en
[`docs/load-results/`](load-results).

En Azure: subir los mismos límites con
`az containerapp update -g rg-arenal-dev -n ca-arenal-dev --set-env-vars RATE_LIMIT_AUTH_PER_MINUTE=100000 …`,
correr `pnpm load --url https://<app>…` y leer CPU y memoria por réplica en las métricas de Container Apps. Al
terminar, volver los límites a sus valores (o volver a desplegar).

## Resultados (local)

Máquina: 2 vCPU y 8 GB. En la misma máquina corrían el servidor (una réplica), Postgres 16, Redis 7 y la propia
herramienta de carga, así que los números son una cota baja de lo que da cada componente por separado. Mesas de 2
jugadores, 45 s por etapa.

### Antes: estado reconstruido desde todos los eventos en cada jugada

| Partidas | Jugadas/s |    p50 |        p95 |    p99 | Errores | Perdidas | CPU servidor | CPU Postgres |    RSS |
| -------: | --------: | -----: | ---------: | -----: | ------: | -------: | -----------: | -----------: | -----: |
|       50 |       193 | 4.2 ms |      13 ms |  20 ms |       0 |        0 |         23 % |         15 % | 238 MB |
|      100 |       380 | 5.4 ms |      18 ms |  34 ms |       0 |        0 |         37 % |         44 % | 291 MB |
|      200 |       644 |  32 ms |     107 ms | 152 ms |       0 |        0 |         57 % |         76 % | 308 MB |
|  **300** |       625 | 161 ms | **271 ms** | 295 ms |       0 |        0 |         56 % |         76 % | 311 MB |
|      400 |       669 | 269 ms |     349 ms | 383 ms |       0 |        0 |         63 % |         83 % | 327 MB |

Punto de quiebre: **300 partidas simultáneas**. Pasadas las 200, el ritmo se estanca en unas 650 jugadas por segundo
y la latencia crece porque las jugadas esperan en la cola de Postgres.

### Después: caché del estado en cada réplica ([ADR 0010](adr/0010-cache-de-estado-por-replica.md))

| Partidas | Jugadas/s |    p50 |        p95 |    p99 | Errores | Perdidas | CPU servidor | CPU Postgres |    RSS |
| -------: | --------: | -----: | ---------: | -----: | ------: | -------: | -----------: | -----------: | -----: |
|       50 |       194 | 3.3 ms |     8.1 ms |  16 ms |       0 |        0 |         18 % |         11 % | 165 MB |
|      100 |       384 | 3.5 ms |      11 ms |  20 ms |       0 |        0 |         28 % |         35 % | 165 MB |
|      200 |       746 | 6.2 ms |      23 ms |  43 ms |       0 |        0 |         48 % |         67 % | 193 MB |
|      300 |       961 |  39 ms |      81 ms | 104 ms |       0 |        0 |         58 % |         86 % | 307 MB |
|      400 |       990 | 107 ms |     164 ms | 191 ms |       0 |        0 |         58 % |         89 % | 307 MB |
|  **500** |       917 | 209 ms | **287 ms** | 334 ms |       0 |        0 |         58 % |         86 % | 377 MB |
|      600 |       906 | 302 ms |     413 ms | 453 ms |       0 |        0 |         58 % |         85 % | 379 MB |

Punto de quiebre: **500 partidas simultáneas** (antes, 300). Con 400 todavía cumple (p95 de 164 ms). El techo
ahora está en unas 950 jugadas por segundo, con Postgres cerca del 90 % de CPU. El servidor nunca pasa del 60 % de un
núcleo: el siguiente cuello de botella es la base, no la réplica.

### La optimización, en números

| Con 300 partidas simultáneas |        Antes |      Después | Cambio |
| ---------------------------- | -----------: | -----------: | -----: |
| p95 de punta a punta         |       271 ms |        81 ms |  −70 % |
| p50                          |       161 ms |        39 ms |  −76 % |
| Jugadas por segundo          |          625 |          961 |  +54 % |
| ¿Cumple p95 < 200 ms?        |           No |           Sí |        |
| Punto de quiebre             | 300 partidas | 500 partidas |  +67 % |

Con 200 partidas, el p95 baja de 107 a 23 ms (−78 %).

**Qué cambió:** antes, cada jugada leía de Postgres todos los eventos de la partida (de 200 a 300 al final), los
parseaba y los volvía a aplicar. Ahora la réplica tiene el estado en memoria y solo comprueba, con la fila bloqueada,
que su versión sea la de la base. La consulta más pesada desaparece de casi todas las jugadas, y Postgres atiende un
54 % más de jugadas con la misma CPU.

### Capacidad por partida

Con la caché, entre 50 y 200 partidas:

- **CPU del servidor:** unos 0.24 % de un núcleo por partida activa (48 % con 200). Una réplica de 0.25 vCPU como la
  de Azure atiende del orden de 100 partidas antes de saturar su CPU.
- **Memoria del servidor:** de 165 MB con 50 partidas a 307 MB con 300, unos 0.6 MB por partida activa (dos conexiones
  WebSocket, el estado en caché y el heap que crece con la carga). En 0.5 GiB entran unas 600 partidas, así que en
  Azure la CPU se acaba antes que la memoria.
- **Postgres:** es el cuello de botella. Cada jugada es una transacción con bloqueo de fila, 3 o 4 escrituras y un
  commit. En Azure, el B1ms con créditos de CPU es lo primero que hay que medir y lo primero que habría que subir.

## Lo que falta medir en Azure

- La misma rampa contra dev, con 2 réplicas, para ver el efecto de la red entre servicios y de la caché con el
  tráfico repartido (la proporción de aciertos sale en la métrica `arenal.state.loads`).
- CPU y memoria por réplica en Container Apps, y CPU y créditos del B1ms en Postgres.
