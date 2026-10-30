# 0008 — Administración: acciones por el dominio y auditoría de solo inserción

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El administrador tiene que poder ver las partidas activas y las conexiones, terminar una partida y suspender a un
usuario. Solo el rol administrador puede hacerlo, y cada acción tiene que quedar auditada. Sus acciones no pueden
romper las garantías del resto del sistema: orden por partida, nadie en dos partidas y ninguna filtración de
información oculta.

## Decisión

- **El rol se revisa en la base en cada solicitud.** La guardia de administración lee el rol y la suspensión de
  Postgres, no del JWT. Quitarle el rol a alguien o suspenderlo aplica en la siguiente solicitud, sin esperar a
  que venza su token.
- **Nadie se da el rol por la API.** El rol se da y se quita solo desde la línea de comandos
  (`node dist/cli/admin.js grant|revoke`), que corre dentro del contenedor. Así no hay ninguna ruta que permita
  escalar privilegios ni una lista de correos de administrador en la configuración (alguien podría registrar esos
  correos antes que su dueño).
- **Terminar una partida es una intención del dominio.** `terminate` produce un `MatchEnded` con resultado
  `aborted`, igual que cualquier fin de partida. Pasa por el mismo bloqueo de la partida, queda en su historia de
  eventos, los jugadores conectados lo reciben por WebSocket y la repetición sigue funcionando. En la base la
  partida queda con estado `aborted` y sus jugadores quedan libres.
- **Suspender aplica de inmediato.** En una transacción: se marca la cuenta, se revocan todas sus sesiones, sale
  de la cola y de su sala, y se audita. Ya confirmado, se aplica el abandono en su partida en curso (el rival no
  espera el periodo de gracia) y se publica un aviso por el canal del usuario en Redis: cada réplica cierra sus
  conexiones con 4003. Para que una conexión que se está abriendo justo en ese momento no se salve, el gateway
  vuelve a revisar la cuenta después de suscribirse al canal del usuario.
- **Auditoría en la misma transacción.** Cada acción escribe su fila en `admin_audit` dentro de la transacción
  que hace el cambio: si no se puede auditar, no se hace. La fila guarda quién (o `null` si fue la línea de
  comandos), qué, sobre qué, el motivo (obligatorio), detalles y el ID de la solicitud para cruzarla con los
  logs. Un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE` sobre la tabla.
- **Las vistas de administración no muestran información oculta.** La lista de partidas trae solo datos
  públicos (turno, jugadores, conexiones); ni manos, ni mazo, ni límite. Las conexiones se leen de un sorted set
  de Redis que comparten todas las réplicas, con el mismo arriendo que la presencia.

## Consecuencias

- El cierre por administración usa el mismo camino que una jugada, así que no hay casos especiales en el reparto
  de eventos ni en la repetición.
- El abandono al suspender corre después de confirmar la suspensión. Si fallara, el jugador ya no puede
  reconectar y el periodo de gracia lo resuelve.
- El trigger evita cambios por error o desde el código de la aplicación, pero el dueño de la tabla puede
  desactivarlo. Separar el rol que migra del rol con que corre la aplicación cerraría eso; queda anotado en el
  modelo de amenazas.
- Las lecturas de administración no van a la tabla de auditoría: cada acceso queda en los logs con el ID del
  administrador y la ruta. Los intentos sin el rol se registran como advertencia.
