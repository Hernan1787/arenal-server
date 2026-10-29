# Reglas de Arenal

Los jugadores echan piedras a un volcán. Cada ronda tiene un límite secreto que nadie conoce, y quien lo pasa
provoca la erupción y pierde una vida. Gana el último en pie.

Estas reglas son exactamente las que implementa `packages/domain`. Los números entre paréntesis son los valores
por defecto de `DEFAULT_CONFIG`; todos son configurables.

## Preparación

- De 2 a 5 jugadores. El servidor sortea el orden de la mesa.
- Mazo de 44 cartas, barajado por el servidor con azar criptográfico:
  - Piedra 1 (×10), Piedra 2 (×10), Piedra 3 (×8), Piedra 4 (×6)
  - Enfriar (×6)
  - Sismógrafo (×4)
- Cada carta lleva un ID aleatorio distinto en cada partida (por ejemplo `c_8f3k2a`), que no revela qué carta es.
- Cada jugador empieza con 3 vidas y 4 cartas. La mano solo la ve su dueño; los demás solo ven cuántas cartas tiene.

## Rondas

- Al empezar cada ronda el servidor sortea un límite secreto entre 15 y 25 (ambos incluidos) y la presión vuelve a 0.
- Nadie recibe el límite mientras la ronda está en curso.

## Turno

El jugador de turno juega exactamente una carta y roba una:

| Carta | Efecto |
| --- | --- |
| Piedra *n* | La presión sube *n*. |
| Enfriar | La presión baja 3, sin quedar por debajo de 0. |
| Sismógrafo | La presión no cambia. El servidor le dice **solo a ese jugador** si al límite le faltan 4 o menos («cerca») o más («lejos»). |

Las cartas jugadas son públicas. Si el mazo se acaba, el servidor baraja el descarte y se sigue robando.

## Erupción

- Si después de jugar la presión **pasa** el límite (llegar justo al límite no cuenta), hay erupción:
  quien jugó pierde 1 vida, se revela el límite a todos y empieza otra ronda con el jugador siguiente.
- Con 0 vidas el jugador queda eliminado, no roba y su mano se descarta sin mostrarse.

## Fin de la partida

- Gana el último jugador que quede en pie.
- Si se cierra la ronda 15, gana quien tenga más vidas; si varios empatan con el máximo, es empate entre ellos.

## Temporizador y abandono

Estas reglas las aplica el servidor; el cliente nunca decide tiempos.

- **Turno vencido** (30 s): el servidor juega por el jugador la piedra de menor valor; si no tiene piedras, el
  sismógrafo; si tampoco, Enfriar. Así dejar vencer el turno nunca conviene.
- **Abandono:** si un jugador sale de la partida o sigue desconectado al vencer el periodo de gracia (60 s),
  queda eliminado y sus cartas se descartan sin mostrarse. Si tenía el turno, pasa al siguiente.

## Qué ve cada quien

| Información | Quién la ve |
| --- | --- |
| Mano de un jugador | Solo su dueño |
| Cuántas cartas tiene cada uno | Todos |
| Orden del mazo | Nadie |
| Límite de la ronda en curso | Nadie |
| Límite de una ronda terminada | Todos |
| Resultado del sismógrafo | Solo quien lo jugó |
| Cartas de un jugador eliminado | Nadie |

## Originalidad

Se inspira en juegos de «no pasarse del límite» como el 99, pero el límite secreto y aleatorio por ronda, las
vidas y el sismógrafo hacen que las reglas sean propias.
