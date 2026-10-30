# Observabilidad

El servidor usa OpenTelemetry y manda trazas y métricas a Application Insights. Los logs salen por stdout en JSON
(pino) y Container Apps los lleva a Log Analytics. Application Insights y Log Analytics comparten el mismo
workspace, así que todo se consulta con KQL en un solo lugar.

## Cómo arranca

- `node --import ./dist/instrument.js dist/main.js` (el `CMD` de la imagen) carga OpenTelemetry antes que el
  servidor. Así las instrumentaciones de HTTP, Postgres y Redis alcanzan a envolver esos módulos.
- Solo arranca si existe `APPLICATIONINSIGHTS_CONNECTION_STRING`, que la plantilla de Bicep pone en Azure. En local
  y en las pruebas la API de OpenTelemetry queda en modo no-op y no se carga nada más.
- La ingesta local de Application Insights está desactivada: la telemetría entra con la identidad administrada
  (`Monitoring Metrics Publisher`). La cadena de conexión sola no sirve para mandar datos.
- Al apagarse, el servidor manda lo que quede pendiente antes de salir.

## Trazas

| Span                                          | Tipo        | Atributos                                                                                             |
| --------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `POST /v1/...` etc.                           | Servidor    | Automáticos de HTTP. Las sondas `/health/*` no se trazan                                              |
| `ws play_card`, `ws leave_match`, `ws resume` | Servidor    | `arenal.match.id`, `arenal.player.id`, `arenal.message.id`                                            |
| `match.apply`                                 | Interno     | `arenal.match.id`, `arenal.player.id`, `arenal.intent`, `arenal.outcome`, `arenal.seq`, `arenal.code` |
| `pg.query:*`                                  | Dependencia | Consulta parametrizada, sin valores                                                                   |
| `redis-*`                                     | Dependencia | Solo el nombre del comando, nunca sus argumentos                                                      |

`match.apply` envuelve toda intención, venga de un jugador, del temporizador, del periodo de gracia o de un
administrador. Las consultas que hace quedan como hijas, y cuando viene de un mensaje del WebSocket, cuelga de
`ws play_card`. Ningún atributo lleva cartas, manos ni el límite de la ronda.

## Métricas propias

| Métrica                     | Tipo            | Para qué                                                                                               |
| --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `arenal.intents`            | Contador        | Jugadas por segundo, rechazos por código (`arenal.intent`, `arenal.outcome`, `arenal.code`)            |
| `arenal.intent.duration`    | Histograma (ms) | Latencia por jugada en el servidor: bloqueo, validación, guardado y aviso a las réplicas               |
| `arenal.event.delivery_lag` | Histograma (ms) | Desde que se publica un evento hasta que sale por el WebSocket de cada jugador, también entre réplicas |
| `arenal.ws.rejected`        | Contador        | Mensajes rechazados antes del dominio: JSON roto, esquema inválido, límite de tasa                     |
| `arenal.ws.connections`     | Indicador       | Conexiones abiertas en cada réplica                                                                    |
| `arenal.matches.active`     | Indicador       | Partidas en curso. Todas las réplicas reportan el mismo número: se usa el máximo                       |

Application Insights guarda de cada histograma la suma, la cantidad, el mínimo y el máximo, pero no los
percentiles. El p95 de punta a punta (jugada enviada hasta estado recibido por todos) lo mide la prueba de carga desde
los clientes.

## Logs

- JSON en una línea, sin encabezados ni query strings (ahí viaja el ticket del WebSocket). Contraseñas, tokens y
  tickets se reemplazan por `[oculto]` si llegaran a aparecer.
- Cada línea escrita dentro de una traza lleva `trace_id` y `span_id`. El `trace_id` es el `operation_Id` de
  Application Insights.
- Las rutas autenticadas agregan `userId`. El WebSocket escribe `conexión abierta` y `conexión cerrada` (con
  `userId`, `matchId` y el código de cierre), y una línea `jugada` por mensaje (con `matchId`, `userId`, `type`,
  `outcome` y `seq`). El reloj del servidor escribe `turno vencido` y `abandono por desconexión`.

## Consultas útiles (Log Analytics)

Todo lo que pasó en una partida, en orden:

```kusto
let partida = "<matchId>";
union
  (AppRequests | where Properties["arenal.match.id"] == partida | project TimeGenerated, Tipo = "solicitud", Nombre = Name, OperationId),
  (AppDependencies | where Properties["arenal.match.id"] == partida | project TimeGenerated, Tipo = "intención", Nombre = strcat(Name, " ", tostring(Properties["arenal.intent"]), " → ", tostring(Properties["arenal.outcome"])), OperationId),
  (ContainerAppConsoleLogs | extend l = parse_json(Log) | where l.matchId == partida | project TimeGenerated, Tipo = "log", Nombre = tostring(l.msg), OperationId = tostring(l.trace_id))
| order by TimeGenerated asc
```

Jugadas por minuto y latencia promedio en el servidor:

```kusto
AppMetrics
| where Name in ("arenal.intents", "arenal.intent.duration") and Properties["arenal.intent"] == "play_card"
| summarize Jugadas = sumif(Sum, Name == "arenal.intents"),
            PromedioMs = sumif(Sum, Name == "arenal.intent.duration") / sumif(ItemCount, Name == "arenal.intent.duration")
    by bin(TimeGenerated, 1m)
| render timechart
```

Conexiones por réplica:

```kusto
AppMetrics
| where Name == "arenal.ws.connections"
| summarize Conexiones = max(Max) by bin(TimeGenerated, 1m), AppRoleInstance
| render timechart
```

## Alertas

Además de las tres alertas de plataforma (5xx, reinicios y CPU de Postgres, ver [deploy.md](deploy.md#alertas)),
hay una sobre la métrica propia:

| Alerta                                | Condición                                                                     | Severidad |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `alert-arenal-<amb>-latencia-jugadas` | El promedio de `arenal.intent.duration` (jugadas) pasa de 100 ms en 5 minutos | 2         |

## Sondas

- `/health/live`: el proceso responde. Container Apps reinicia la réplica si falla 3 veces.
- `/health/ready`: Postgres y Redis responden, y la réplica no está drenando. Si falla, la réplica deja de recibir
  tráfico pero no se reinicia.
