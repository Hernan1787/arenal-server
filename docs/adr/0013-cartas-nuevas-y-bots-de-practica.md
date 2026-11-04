# 0013 — Cartas nuevas, ritmo de la mesa y bots de práctica en el navegador

- Estado: aceptada
- Fecha: 4 de noviembre de 2026

## Contexto

Jugando en la web se vio que el juego tenía poca variedad (piedras, Enfriar y Sismógrafo), que con tres bots
la mesa era un caos y que los bots jugaban tan rápido (0,3 s) que no se alcanzaba a ver cada jugada. Además,
jugar solo pedía abrir una terminal para traer bots.

## Decisión

- **Siete cartas nuevas** (ver [game-rules.md](../game-rules.md)): Bomba, Temblor, Lluvia, Desvío, Ceniza, Robo
  y Escudo. Todas se resuelven en el dominio puro, con el mismo `decide`/`evolve`:
  - Lo que se decide por azar (el número del Temblor, la carta que se ve o se roba) lo sortea el servidor con su
    `Rng` y queda dentro del evento, como el límite de la ronda. Repetir la partida no vuelve a sortear.
  - **Ceniza muestra la carta sin su ID** (`CardFace`). Quien mira sabe qué carta era, pero los IDs opacos siguen
    sin salir de la mano de su dueño: la prueba de propiedades «ninguna vista contiene cartas ajenas» se mantiene
    sin excepciones.
  - **Robo** manda la carta (con ID) solo al ladrón y a la víctima; los demás reciben el evento sin carta.
  - **Desvío** son dos turnos seguidos del mismo jugador (`TurnStarted` con `playsLeft`), cada uno con su número
    de turno: el temporizador y la regla de «temporizador viejo» funcionan sin cambios en el servidor.
  - El rival va en la jugada (`targetId`); el dominio lo valida (`TARGET_REQUIRED`, `INVALID_TARGET`) y el
    contrato lo acepta solo en `play_card`.
- **Partidas viejas.** Los campos nuevos de los eventos son opcionales (un `TurnStarted` sin `playsLeft` es de una
  carta) y `completeConfig` completa la configuración guardada de una partida vieja. Las partidas que ya estaban en
  la base se siguen cargando y repitiendo.
- **Partidas más cortas.** Las cartas nuevas alargan las rondas. Se simularon 400 partidas por variante con la
  estrategia de los bots y se eligió 2 vidas y límite entre 12 y 20: la mediana queda en 40 jugadas con 2
  jugadores, 88 con 3 y 136 con 4 (con las reglas anteriores y las cartas nuevas eran 104, 214 y 269).
- **La mesa muestra los eventos en cola.** Cada evento se muestra el tiempo necesario para verlo (la carta vuela
  al cráter y el magma sube al caer; la erupción dura 2,6 s) aunque lleguen varios juntos. La mano solo se
  habilita cuando la cola llega a tu turno, y el temporizador cuenta desde que llegó el evento, no desde que se
  mostró.
- **Bots de práctica en la misma pestaña.** «Jugar contra bots» crea una sala privada y mete de 1 a 3 bots. Cada
  bot es un jugador normal para el servidor: su cuenta temporal, su WebSocket, su vista filtrada y la misma
  estrategia de `@arenal/client`, pensando entre 1,2 y 2,6 s. El servidor no tiene ningún camino especial para
  ellos. Si se recarga la página, los bots vuelven a conectarse y siguen la partida.

## Alternativas descartadas

- **Bots dentro del servidor.** Evitaban las cuentas temporales, pero metían en el servidor un jugador que no
  pasa por la autenticación ni por el WebSocket, y cada réplica tendría que decidir quién los mueve. Con los bots
  en el navegador el servidor sigue tratando igual a todos.
- **Mostrar la carta vista con su ID.** Era más simple, pero rompía la propiedad de que ningún ID de carta sale
  de la mano de su dueño, y daba información de más (seguir esa carta si después la roban).
- **Desvío como un turno con dos jugadas.** Habría que cambiar el temporizador para que diera más tiempo y
  aceptara dos jugadas con el mismo número de turno.

## Consecuencias

- Al probar los bots se encontró un error del servidor: quien ya estaba conectado cuando se creaba su partida
  (siempre pasa con la cola y con los bots) nunca quedaba marcado como presente, y al vencer el periodo de gracia
  caía en abandono jugando. Se corrigió en dos lugares: la conexión se marca presente al engancharse a la partida,
  y el barrido de abandonos pregunta a Redis antes de sacar a alguien. Lo cubre una prueba de integración.
- En la práctica, el jugador puede ver en las herramientas del navegador las manos de sus propios bots, porque
  corren en su pestaña. Solo pasa en la sala privada que él mismo creó; no afecta partidas con otras personas.
  Queda como riesgo aceptado en el modelo de amenazas.
- El contrato pasa a la versión 0.4.0 (eventos `CardPeeked` y `CardStolen`, campos nuevos en la vista).
