# Modelo de amenazas

Método: STRIDE sobre el diagrama de flujo de datos de la arquitectura en Azure ([deploy.md](deploy.md)). Para cada
amenaza se indica el control que la mitiga, dónde está y cómo se prueba. Al final, los riesgos que se aceptan.

## Activos

| Activo                             | Por qué importa                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Información oculta de cada partida | Manos, orden del mazo, límite de la ronda y lecturas de sismógrafo. Si se filtra, se puede hacer trampa |
| Integridad de las partidas         | Orden de las jugadas, resultado inmutable, nadie juega por otro                                         |
| Cuentas y sesiones                 | Contraseñas (hash), refresh tokens, rol de administrador                                                |
| Llave de firma de los JWT          | Con ella se puede emitir un token de cualquier usuario                                                  |
| Registro de auditoría              | Prueba de lo que hizo cada administrador                                                                |
| Disponibilidad                     | Partidas en curso, crédito de Azure                                                                     |

## Fronteras de confianza

```
 Internet ──(1)──▶ Ingress de Container Apps (TLS) ──▶ Réplicas del servidor ──(2)──▶ Postgres / Redis / Key Vault
                                                              ▲
 GitHub Actions ──(3) OIDC──▶ Azure Resource Manager ─────────┘        Administrador ──(4) CLI en el contenedor
```

1. Clientes (navegador, bot, terminal): no confiables. Todo lo que mandan se valida.
2. Servicios de datos: confiables solo con la identidad administrada, nunca con secretos.
3. Pipeline: entra con una credencial federada por environment; prod pide aprobación.
4. Operación: el rol de administrador solo se da desde dentro del contenedor.

## Amenazas y controles

### Suplantación (Spoofing)

| Amenaza                                                    | Control                                                                                                          | Evidencia                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Robar o adivinar la contraseña de alguien                  | Argon2id (19 MiB, t=2); mismo tiempo de respuesta exista o no el correo; límite de 10 intentos por minuto por IP | `auth.test.ts`                  |
| Reusar un refresh token robado                             | Rotación en cada uso; si llega uno ya usado se revoca toda la familia                                            | `auth.test.ts`                  |
| Usar un access token robado por mucho tiempo               | JWT ES256 de 10 minutos; suspensión y cambio de rol aplican en la siguiente solicitud (se leen de la base)       | `auth.test.ts`, `admin.test.ts` |
| Abrir el WebSocket como otro jugador                       | Ticket aleatorio de un solo uso (30 s, `GETDEL` en Redis, guardado como hash); sin ticket válido no hay socket   | `realtime.test.ts`              |
| Un sitio ajeno abre el WebSocket con la sesión del jugador | Lista de `Origin` permitidos en el handshake y en CORS                                                           | `realtime.test.ts`              |
| Suplantar al servidor ante Postgres o Redis                | Solo Entra ID con la identidad administrada; TLS obligatorio (la configuración no arranca sin él)                | `infra.test.ts`, Bicep          |
| Suplantar al pipeline                                      | OIDC con credencial federada atada al repo y al environment; sin secretos de Azure en GitHub                     | `bootstrap.sh`                  |

### Manipulación (Tampering)

| Amenaza                                                            | Control                                                                                                                                               | Evidencia                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Mandar resultados en lugar de intenciones                          | Servidor autoritativo: el cliente solo manda `play_card` con un ID de carta; el dominio decide                                                        | `rules.test.ts`                    |
| Jugar fuera de turno o una carta ajena                             | El dominio valida turno, participación y que la carta esté en la mano                                                                                 | `rules.test.ts`, `matches.test.ts` |
| Mensajes malformados o enormes                                     | Cada mensaje se valida con Zod (tipos, rangos, campos extra prohibidos); 4 KB por mensaje de WebSocket y 16 KB por cuerpo HTTP; `__proto__` bloqueado | `realtime.test.ts`, `app.test.ts`  |
| Reordenar o duplicar jugadas (reenvíos, carreras, varias réplicas) | `FOR UPDATE` por partida, `expectedSeq`, idempotencia por `moveId` (y `MOVE_ID_CONFLICT` si otro usuario reusa el ID)                                 | `matches.test.ts`                  |
| Alterar el registro de auditoría                                   | Trigger que rechaza `UPDATE`, `DELETE` y `TRUNCATE`; la fila se escribe en la misma transacción que la acción                                         | `admin.test.ts`                    |
| Imagen o dependencias comprometidas                                | Dependabot, CodeQL, gitleaks y Trivy (falla con vulnerabilidades críticas) en cada PR; prod usa la misma imagen que pasó por dev                      | CI                                 |

### Repudio (Repudiation)

| Amenaza                              | Control                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un administrador niega haber actuado | `admin_audit`: quién, qué, sobre qué, motivo obligatorio, ID de la solicitud; no se puede editar                                                           |
| Un jugador niega una jugada          | Cada partida es su lista de eventos con `seq`; la repetición la reconstruye jugada por jugada. Cada jugada deja una línea de log con el jugador y la traza |
| No se puede reconstruir qué pasó     | Logs con `trace_id`, `userId` y `matchId`; trazas por mensaje en Application Insights ([observability.md](observability.md))                               |

### Divulgación de información (Information disclosure)

| Amenaza                                  | Control                                                                                                                                    | Evidencia                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Ver la mano de otro, el mazo o el límite | `viewFor` y `projectEvent` filtran por jugador; la respuesta pasa además por el esquema, que descarta campos extra                         | `hidden-info.test.ts` (propiedades sobre partidas al azar), `realtime.test.ts` |
| Ver partidas ajenas o salas privadas     | 404 (no 403) para quien no participa, así no se puede averiguar qué existe                                                                 | `matches.test.ts`, `rooms.test.ts`                                             |
| Filtración por logs o telemetría         | Sin encabezados ni query strings; contraseñas, tokens y tickets redactados; Redis sin argumentos en las trazas; ningún atributo con cartas | `app.test.ts`, `observability.test.ts`                                         |
| Errores que revelan detalles internos    | Problem Details sin trazas, consultas ni valores enviados                                                                                  | `app.test.ts`                                                                  |
| Administración ve información oculta     | La vista de administración solo trae datos públicos                                                                                        | `admin.test.ts`                                                                |
| Tráfico interceptado                     | Solo HTTPS y WSS en el ingress (`allowInsecure: false`), HSTS; TLS hacia Postgres y Redis                                                  | Bicep                                                                          |
| Secretos en el repo                      | No hay ninguno: gitleaks en el hook de pre-commit y en CI; la llave de JWT se genera en el runner y va directo a Key Vault                 | CI                                                                             |

### Denegación de servicio (Denial of service)

| Amenaza                                          | Control                                                                                                                                                                                                                                                                 | Evidencia                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Inundar la API                                   | Límite por IP en registro, login y refresh; límite por usuario en toda ruta autenticada (300/min por defecto, más estricto en tickets, códigos de sala y administración). Los contadores viven en Redis y son compartidos por todas las réplicas. 429 con `Retry-After` | `rate-limit.test.ts`, `auth.test.ts`             |
| Inundar el WebSocket                             | 10 mensajes/s con ráfagas de 20 por conexión; 3 conexiones por usuario; heartbeat que cierra conexiones muertas                                                                                                                                                         | `realtime.test.ts`, `realtime-heartbeat.test.ts` |
| Un jugador traba una partida                     | Temporizador de turno con jugada por defecto; abandono al vencer el periodo de gracia                                                                                                                                                                                   | `realtime.test.ts`                               |
| Una partida con datos corruptos tumba el proceso | Cada partida se procesa aparte; un error en una no detiene el barrido ni el resto                                                                                                                                                                                       | `sweeper.ts`                                     |
| Agotar el crédito de Azure                       | Presupuesto con aviso al 50 % y al 100 % del pronóstico; dev escala a cero; tope diario de logs                                                                                                                                                                         | Bicep                                            |

### Elevación de privilegios (Elevation of privilege)

| Amenaza                                         | Control                                                                                                                               | Evidencia       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Un jugador usa funciones de administración      | Guardia de rol en cada ruta; el rol se lee de la base, no del JWT                                                                     | `admin.test.ts` |
| Darse el rol de administrador                   | No existe ninguna ruta para eso: solo la CLI dentro del contenedor, auditada                                                          | `admin.test.ts` |
| Un administrador se suspende a sí mismo o abusa | No puede suspenderse; cada acción queda auditada con motivo                                                                           | `admin.test.ts` |
| Escapar del contenedor                          | La imagen corre como usuario sin privilegios                                                                                          | CI              |
| La identidad de la app hace más de lo debido    | Roles mínimos: `AcrPull`, `Key Vault Secrets User`, `Monitoring Metrics Publisher` y administración de su propio servidor de Postgres | Bicep           |

## Riesgos aceptados

| Riesgo                                                      | Por qué se acepta                                                                                                                                   | Qué lo reduciría                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Postgres y Redis con endpoint público (sin VNet)            | Los endpoints privados y la VNet suben el costo fuera del crédito de estudiante. Sin un token de Entra ID del tenant no se entra, y todo va por TLS | Ambiente de Container Apps con VNet y endpoints privados       |
| La identidad de la app es dueña de las tablas               | Es la administradora de Entra ID de su servidor; podría desactivar el trigger de auditoría                                                          | Un rol que migra y otro, sin privilegios de dueño, que atiende |
| Si Redis cae, los límites de tasa dejan pasar               | Se prefiere seguir atendiendo a bloquear a todos; los límites del WebSocket son locales y siguen funcionando                                        | Límite de respaldo en memoria por réplica                      |
| El registro dice si un correo ya existe (409 `EMAIL_TAKEN`) | Sin verificación de correo, es la forma más clara de avisarle al usuario                                                                            | Registro con confirmación por correo                           |
| Sin WAF delante del ingress                                 | No entra en el crédito                                                                                                                              | Azure Front Door con WAF                                       |
| Una sola región                                             | Costo                                                                                                                                               | Réplica de lectura y despliegue en otra región                 |
