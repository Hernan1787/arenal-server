# 0005 — Salas y cola de emparejamiento en Postgres

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El enunciado exige que la capacidad de una sala se respete aunque varios se unan a la vez, y que un jugador
nunca quede asignado a dos partidas. El plan inicial ponía la cola de emparejamiento en Redis con un script Lua.

## Decisión

Salas, miembros y tickets de la cola viven en Postgres, igual que las partidas:

- **Capacidad:** unirse es un `UPDATE rooms SET member_count = member_count + 1 WHERE … AND member_count < capacity`.
  La fila queda bloqueada durante la transacción, así que las uniones simultáneas se procesan de a una.
- **Un lugar por usuario:** toda operación que mete a un usuario en una sala, en la cola o en una partida
  empieza bloqueando su fila en `users`. Además, un índice único parcial
  (`match_players (user_id) WHERE active`) impide a nivel de base que alguien esté activo en dos partidas.
- **Cola:** los tickets son filas. El emparejador corre bajo `pg_advisory_xact_lock`, así que aunque todas las
  réplicas lo llamen cada segundo, solo una arma partidas a la vez. Arma grupos del tamaño configurado, rellena
  con los que haya (mínimo 2) después de `MATCHMAKING_FILL_AFTER_MS` y vence tickets después de
  `MATCHMAKING_MAX_WAIT_MS`.
- **Inicio:** una sala arranca sola cuando hay 2 o más miembros y todos marcaron «listo». La partida se crea en
  la misma transacción que cierra la sala.

## Consecuencias

- Crear la partida y sacar a los jugadores de la sala o la cola es atómico: no hay un estado intermedio que
  limpiar si algo falla.
- Hay una sola fuente de verdad. Redis queda para lo que sí necesita: repartir eventos entre réplicas.
- La cola tiene un único candado global. Con cientos de jugadores por segundo sería un cuello de botella; para
  este proyecto el emparejador tarda milisegundos. Las pruebas de integración cubren 10 entradas simultáneas con
  barridos en paralelo.
