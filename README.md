# Arenal — servidor de juego por turnos

Servidor autoritativo del juego **Arenal** para el proyecto 2 de Diseño de Software (TEC, II semestre 2026,
Ing. Jonathan Solís Parajeles). El servidor valida cada jugada, es la única fuente de verdad de la partida y
le manda a cada jugador solo lo que le toca ver.

Equipo: Hernán Alonso Gutiérrez Quesada y José Andrés Acuña Garay.

Las reglas del juego están en [docs/game-rules.md](docs/game-rules.md).

## Estado

| Parte                                          | Estado                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motor de reglas (`packages/domain`)            | Listo, con pruebas unitarias y de propiedades                                                                                                                                                  |
| Contrato en tiempo real (`packages/contracts`) | Mensajes, errores y códigos de cierre; genera AsyncAPI 3.0                                                                                                                                     |
| Usuarios                                       | Registro, login, refresh rotativo, logout y perfil; Argon2id y JWT ES256                                                                                                                       |
| Salas                                          | Públicas y privadas (código), listar, unirse, salir, «listo» con inicio automático; capacidad atómica                                                                                          |
| Emparejamiento                                 | Cola rápida con relleno y tiempo máximo configurables; nadie queda en dos partidas                                                                                                             |
| Partidas                                       | Persistencia en Postgres con orden por partida, `expectedSeq`, idempotencia por `moveId`, historial y repetición                                                                               |
| API REST                                       | OpenAPI 3.1 publicada en `/docs`, errores en Problem Details                                                                                                                                   |
| Tiempo real                                    | WebSocket con ticket de un solo uso, heartbeat, límites por conexión, snapshot al conectar y eventos en orden                                                                                  |
| Reloj del servidor                             | Turnos con temporizador y acción por defecto; periodo de gracia y abandono                                                                                                                     |
| Varias réplicas                                | Eventos repartidos por Redis pub/sub, huecos rellenados desde Postgres, cierre 1012 al apagar                                                                                                  |
| Administración                                 | Partidas en curso, conexiones de todas las réplicas, terminar partida, suspender y reactivar; todo auditado                                                                                    |
| Infraestructura en Azure (Bicep) y despliegue  | Bicep completo, identidad administrada sin contraseñas, dev automático, prod con aprobación, rollback; falta la suscripción                                                                    |
| Observabilidad                                 | OpenTelemetry a Application Insights: trazas por partida, métricas propias, logs con `trace_id`, 4 alertas                                                                                     |
| Bot y cliente de prueba                        | Bots que juegan solos por la cola (`pnpm bot`) y cliente en la terminal (`pnpm play`)                                                                                                          |
| Prueba de carga                                | Partidas reales por WebSocket. En local cumple p95 < 200 ms hasta 400 partidas simultáneas; la caché de estado subió el punto de quiebre de 300 a 500 ([docs/load-test.md](docs/load-test.md)) |

URL pública en Azure: pendiente (falta activar la suscripción; los pasos están en [docs/deploy.md](docs/deploy.md)).

## Correr local (menos de 10 minutos)

Requisitos: Docker con Docker Compose.

```bash
docker compose up --build
curl localhost:8080/health/ready
# {"status":"ready","checks":{"postgres":"ok","redis":"ok"}}
```

Compose levanta Postgres 17, Redis 7.4 y el servidor, que aplica las migraciones al arrancar. La API queda
documentada en http://localhost:8080/docs. No hay contraseñas: Postgres usa autenticación `trust` y los
puertos solo escuchan en `127.0.0.1`.

Fuera de producción, si no se configura `JWT_PRIVATE_KEY`, el servidor genera una llave temporal y los tokens
dejan de servir al reiniciar. En Azure la llave viene de Key Vault.

## Desarrollo

Requisitos: Node 24 o superior y pnpm 10 (`npm install -g pnpm@10`).

```bash
pnpm install
pnpm test              # pruebas unitarias (no necesitan base de datos)
pnpm lint              # ESLint estricto (sin any, dominio puro)
pnpm typecheck         # TypeScript estricto
pnpm contracts:check   # AsyncAPI y OpenAPI generados están al día con el código

docker compose up -d postgres redis
pnpm test:integration  # contra Postgres y Redis reales: concurrencia, WebSocket, varias réplicas
pnpm dev               # servidor con recarga en http://localhost:8080
```

`pnpm install` activa un hook de pre-commit que corre [gitleaks](https://github.com/gitleaks/gitleaks) si está
instalado. El CI lo corre siempre.

## Jugar: bot y cliente de prueba

Con el servidor corriendo (`docker compose up` o `pnpm dev`):

```bash
pnpm bot --bots 4 --games 3            # 4 bots juegan 3 partidas por la cola rápida
pnpm play --name Hernán                 # cliente en la terminal; en otra terminal: pnpm bot --bots 3
pnpm load --matches 50 --duration 60    # prueba de carga (ver docs/load-test.md)
```

Los tres aceptan `--url` (por defecto `http://localhost:8080`). Usan el paquete `packages/client`, que valida cada
mensaje del servidor contra el contrato y mantiene la vista de la partida aplicando los eventos con
`applyPlayerEvent` del dominio.

## Administración

Las rutas `/v1/admin/*` son solo para el rol administrador (ver `/docs`). Nadie puede darse ese rol por la API:
se da desde la línea de comandos, y queda en la auditoría.

```bash
# con docker compose
docker compose exec server node dist/cli/admin.js grant tu@correo.com --reason "Primer administrador"
# en desarrollo
pnpm --filter @arenal/server admin grant tu@correo.com --reason "Primer administrador"
```

`revoke` quita el rol. El rol se revisa en la base en cada solicitud, así que el cambio aplica de inmediato. Cada
acción (terminar una partida, suspender, reactivar, dar o quitar el rol) escribe una fila en `admin_audit` dentro de
la misma transacción; la tabla rechaza cambios y borrados. Detalle en el
[ADR 0008](docs/adr/0008-administracion-y-auditoria.md).

## Estructura

```
packages/domain      motor de reglas puro: decide, evolve, viewFor, projectEvent
packages/contracts   esquemas Zod del protocolo; genera generated/asyncapi.yaml y guarda openapi.json
packages/client      cliente REST y WebSocket (lo usan el bot, el cliente de prueba y la prueba de carga)
apps/bot             bot, cliente en la terminal y prueba de carga
apps/server
  src/auth           contraseñas (Argon2id), JWT y refresh tokens
  src/lobby          salas y cola de emparejamiento
  src/matches        persistencia de partidas: orden, idempotencia, historial y repetición
  src/realtime       WebSocket, tickets, presencia, reparto entre réplicas y reloj del servidor
  src/admin          funciones del administrador y auditoría
  src/observability  OpenTelemetry: arranque, trazas y métricas propias
  src/cli            línea de comandos de operación (dar o quitar el rol de administrador)
  src/http           rutas, esquemas de la API, guardia de autenticación, Problem Details
  src/db             migraciones y transacciones
  test/integration   pruebas contra Postgres real
infra/               Bicep (main.bicep, módulos, parámetros de dev y prod) y scripts de despliegue y rollback
docs/                reglas, decisiones de arquitectura (ADR), catálogo de errores y guía de despliegue
.github/             CI (lint, tipos, pruebas, contratos, Bicep, gitleaks, imagen, Trivy), despliegue, rollback,
                     CodeQL y Dependabot
```

El dominio no depende de nada: ni red, ni base de datos, ni framework, ni reloj ni `Math.random`. Una regla
de ESLint y una prueba de arquitectura rompen el build si alguien lo intenta. El azar entra por un puerto
(`Rng`) que en producción usa `crypto.randomInt`.

## Contratos

- **REST:** OpenAPI 3.1 en `/docs` (interfaz) y `/docs/json`. Copia versionada en
  [`packages/contracts/generated/openapi.json`](packages/contracts/generated/openapi.json); se genera desde las
  rutas reales con `pnpm contracts:generate` y una prueba falla si quedó desactualizada.
- **Tiempo real:** `wss://<host>/v1/realtime?ticket=…`, con el ticket de `POST /v1/realtime/tickets`. Contrato en
  [`packages/contracts/generated/asyncapi.yaml`](packages/contracts/generated/asyncapi.yaml), generado desde los
  esquemas Zod. No se edita a mano.
- **Errores HTTP:** Problem Details (RFC 9457). Catálogo en [docs/problems.md](docs/problems.md).

## Seguridad

El modelo de amenazas (STRIDE, con cada control, dónde está y qué prueba lo cubre, y los riesgos aceptados) está en
[docs/threat-model.md](docs/threat-model.md).

## Decisiones de arquitectura

En [docs/adr](docs/adr):

1. [TypeScript sobre Node 24](docs/adr/0001-typescript-node-24.md)
2. [El dominio decide con eventos y Postgres ordena las jugadas](docs/adr/0002-eventos-y-orden-en-postgres.md)
3. [Azure Managed Redis en lugar de Azure Cache for Redis](docs/adr/0003-azure-managed-redis.md)
4. [WebSocket con `ws` en lugar de Socket.IO](docs/adr/0004-websocket-con-ws.md)
5. [Salas y cola de emparejamiento en Postgres](docs/adr/0005-salas-y-cola-en-postgres.md)
6. [Autenticación propia con JWT ES256 y refresh rotativo](docs/adr/0006-autenticacion-propia.md)
7. [Tiempo real entre réplicas: Redis para avisar, Postgres para no perder nada](docs/adr/0007-tiempo-real-entre-replicas.md)
8. [Administración: acciones por el dominio y auditoría de solo inserción](docs/adr/0008-administracion-y-auditoria.md)
9. [Despliegue en Azure: Container Apps, identidad administrada y revisiones con tráfico dividido](docs/adr/0009-despliegue-en-azure.md)
10. [Caché del estado de las partidas en cada réplica](docs/adr/0010-cache-de-estado-por-replica.md)

## Azure

La guía completa está en [docs/deploy.md](docs/deploy.md): arquitectura, quién accede a qué, la preparación única,
qué hace cada despliegue, el rollback, cómo reconstruir un ambiente y el costo mensual estimado. Qué se mide y cómo se
consulta está en [docs/observability.md](docs/observability.md).
