# Reglas de Arenal

Los jugadores echan piedras a un volcán. Cada ronda tiene un límite secreto que nadie conoce, y quien lo pasa
provoca la erupción y pierde una vida. Gana el último en pie.

Estas reglas son exactamente las que implementa `packages/domain`. Los números entre paréntesis son los valores
por defecto de `DEFAULT_CONFIG`; todos son configurables.

## Preparación

- De 2 a 5 jugadores. El servidor sortea el orden de la mesa.
- Mazo de 60 cartas, barajado por el servidor con azar criptográfico (ver [Las cartas](#las-cartas)).
- Cada carta lleva un ID aleatorio distinto en cada partida (por ejemplo `c_8f3k2a`), que no revela qué carta es.
- Cada jugador empieza con 2 vidas y 4 cartas. La mano solo la ve su dueño; los demás solo ven cuántas cartas tiene.

## Rondas

- Al empezar cada ronda el servidor sortea un límite secreto entre 12 y 20 (ambos incluidos) y la presión vuelve a 0.
- Nadie recibe el límite mientras la ronda está en curso.

## Turno

El jugador de turno juega exactamente una carta y roba una. Las cartas jugadas son públicas. Si el mazo se
acaba, el servidor baraja el descarte y se sigue robando.

## Las cartas

| Carta              | Cuántas | Efecto                                                                                                                                                                   |
| ------------------ | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Piedra _n_ (1 a 4) |      34 | La presión sube _n_ (10 de 1, 10 de 2, 8 de 3 y 6 de 4).                                                                                                                 |
| Bomba              |       3 | La presión sube 5.                                                                                                                                                       |
| Temblor            |       4 | La presión sube entre 1 y 4. El número lo sortea el servidor al jugarla y queda en el evento: nadie lo sabe antes, ni quien la juega.                                    |
| Enfriar            |       3 | La presión baja 3, sin quedar por debajo de 0.                                                                                                                           |
| Lluvia             |       1 | La presión baja 5, sin quedar por debajo de 0.                                                                                                                           |
| Sismógrafo         |       4 | La presión no cambia. El servidor le dice **solo a ese jugador** si al límite le faltan 4 o menos («cerca») o más («lejos»).                                             |
| Desvío             |       3 | La presión no cambia y el siguiente jugador tiene que jugar **dos cartas** en su turno.                                                                                  |
| Ceniza             |       3 | Se juega contra un rival con cartas. El servidor elige al azar una carta de su mano y se la muestra **solo a quien la jugó** (y al rival, que sabe qué le vieron).       |
| Robo               |       3 | Se juega contra un rival con cartas. El servidor elige al azar una carta de su mano y pasa a la mano de quien la jugó; el rival roba otra del mazo y quien robó no roba. |
| Escudo             |       2 | Se juega boca arriba. La próxima erupción que provoque ese jugador no le quita vida, y el escudo se gasta. No se puede tener dos a la vez.                               |

### Desvío

- Las dos cartas son dos turnos seguidos del mismo jugador, cada uno con su propio temporizador.
- Si la primera carta provoca la erupción, la ronda nueva empieza normal y la segunda carta ya no se debe.
- Jugar Desvío durante un Desvío corta el turno: la carta que faltaba ya no se juega y el siguiente juega dos.

### Ceniza y Robo

- La jugada dice contra quién (`targetId`). Sin rival la rechaza con `TARGET_REQUIRED`; contra uno mismo, un
  eliminado, alguien sin cartas o alguien que no juega, con `INVALID_TARGET`. Una carta que no va contra nadie
  tampoco acepta rival.
- Lo que se ve con Ceniza llega **sin el ID de la carta**: quien mira sabe qué carta era, pero no puede seguirle la
  pista después (si el rival la juega o se la roban). Lo visto dura hasta que termina la ronda.

## Erupción

- Si después de jugar la presión **pasa** el límite (llegar justo al límite no cuenta), hay erupción:
  quien jugó pierde 1 vida (o gasta su Escudo), se revela el límite a todos y empieza otra ronda con el jugador
  siguiente.
- Con 0 vidas el jugador queda eliminado, no roba y su mano se descarta sin mostrarse.

## Fin de la partida

- Gana el último jugador que quede en pie.
- Si se cierra la ronda 15, gana quien tenga más vidas; si varios empatan con el máximo, es empate entre ellos.
- Un administrador puede terminar una partida en curso: se cierra sin ganador (resultado `aborted`) y ninguna mano
  se revela.

## Temporizador y abandono

Estas reglas las aplica el servidor; el cliente nunca decide tiempos.

- **Turno vencido** (30 s): el servidor juega por el jugador, en este orden de preferencia: la piedra de menor
  valor, Temblor, Sismógrafo, Enfriar, Lluvia, Desvío, Escudo (si no tiene uno), Bomba, Ceniza y Robo (contra el
  siguiente jugador con cartas). Las que dan ventaja van al final: dejar vencer el turno nunca conviene.
- **Abandono:** si un jugador sale de la partida o sigue desconectado al vencer el periodo de gracia (60 s),
  queda eliminado y sus cartas se descartan sin mostrarse. Si tenía el turno (aunque fuera la segunda carta de un
  Desvío), pasa al siguiente.

## Qué ve cada quien

| Información                        | Quién la ve              |
| ---------------------------------- | ------------------------ |
| Mano de un jugador                 | Solo su dueño            |
| Cuántas cartas tiene cada uno      | Todos                    |
| Orden del mazo                     | Nadie                    |
| Límite de la ronda en curso        | Nadie                    |
| Límite de una ronda terminada      | Todos                    |
| Resultado del sismógrafo           | Solo quien lo jugó       |
| Número del Temblor                 | Todos, cuando ya se jugó |
| Carta vista con Ceniza (sin su ID) | Quien la jugó y el rival |
| Carta robada con Robo              | El ladrón y la víctima   |
| Quién tiene Escudo                 | Todos                    |
| Cartas de un jugador eliminado     | Nadie                    |

## Duración

Con las cartas nuevas las rondas se alargan (hay más formas de no subir la presión), así que se bajaron las
vidas de 3 a 2 y el límite de 15–25 a 12–20. En 400 partidas simuladas con la estrategia de los bots, la mediana
es de 40 jugadas con 2 jugadores, 88 con 3 y 136 con 4, y casi ninguna llega a la ronda 15.

## Originalidad

Se inspira en juegos de «no pasarse del límite» como el 99, pero el límite secreto y aleatorio por ronda, las
vidas, el sismógrafo y las cartas contra rivales hacen que las reglas sean propias.
