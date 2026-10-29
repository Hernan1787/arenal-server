# Arenal — servidor de juego por turnos

Servidor autoritativo del juego **Arenal** para el proyecto 2 de Diseño de Software (TEC, II semestre 2026,
Ing. Jonathan Solís Parajeles). El servidor valida cada jugada, es la única fuente de verdad de la partida y
le manda a cada jugador solo lo que le toca ver.

Equipo: Hernán Alonso Gutiérrez Quesada y José Andrés Acuña Garay.

Las reglas del juego están en [docs/game-rules.md](docs/game-rules.md).

## Estado

| Parte                                          | Estado                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Motor de reglas (`packages/domain`)            | Listo, con pruebas unitarias y de propiedades                                                                    |
| Contrato en tiempo real (`packages/contracts`) | v0: mensajes, errores y códigos de cierre; genera AsyncAPI 3.0                                                   |
| Usuarios                                       | Registro, login, refresh rotativo, logout y perfil; Argon2id y JWT ES256                                         |
| Salas                                          | Públicas y privadas (código), listar, unirse, salir, «listo» con inicio automático; capacidad atómica            |
| Emparejamiento                                 | Cola rápida con relleno y tiempo máximo configurables; nadie queda en dos partidas                               |
| Partidas                                       | Persistencia en Postgres con orden por partida, `expectedSeq`, idempotencia por `moveId`, historial y repetición |
| API REST                                       | OpenAPI 3.1 publicada en `/docs`, errores en Problem Details                                                     |
| Tiempo real                                    | WebSocket con ticket de un solo uso, heartbeat, límites por conexión, snapshot al conectar y eventos en orden    |
| Reloj del servidor                             | Turnos con temporizador y acción por defecto; periodo de gracia y abandono                                       |
| Varias réplicas                                | Eventos repartidos por Redis pub/sub, huecos rellenados desde Postgres, cierre 1012 al apagar                    |
| Administración                                 | Pendiente                                                                                                        |
| Infraestructura en Azure (Bicep) y despliegue  | Pendiente                                                                                                        |
| Prueba de carga                                | Pendiente                                                                                                        |

URL pública en Azure: pendiente.

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

## Estructura

```
packages/domain      motor de reglas puro: decide, evolve, viewFor, projectEvent
packages/contracts   esquemas Zod del protocolo; genera generated/asyncapi.yaml y guarda openapi.json
apps/server
  src/auth           contraseñas (Argon2id), JWT y refresh tokens
  src/lobby          salas y cola de emparejamiento
  src/matches        persistencia de partidas: orden, idempotencia, historial y repetición
  src/realtime       WebSocket, tickets, presencia, reparto entre réplicas y reloj del servidor
  src/http           rutas, esquemas de la API, guardia de autenticación, Problem Details
  src/db             migraciones y transacciones
  test/integration   pruebas contra Postgres real
docs/                reglas, decisiones de arquitectura (ADR) y catálogo de errores
.github/             CI (lint, tipos, pruebas, contratos, gitleaks, imagen, Trivy), CodeQL y Dependabot
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

## Decisiones de arquitectura

En [docs/adr](docs/adr):

1. [TypeScript sobre Node 24](docs/adr/0001-typescript-node-24.md)
2. [El dominio decide con eventos y Postgres ordena las jugadas](docs/adr/0002-eventos-y-orden-en-postgres.md)
3. [Azure Managed Redis en lugar de Azure Cache for Redis](docs/adr/0003-azure-managed-redis.md)
4. [WebSocket con `ws` en lugar de Socket.IO](docs/adr/0004-websocket-con-ws.md)
5. [Salas y cola de emparejamiento en Postgres](docs/adr/0005-salas-y-cola-en-postgres.md)
6. [Autenticación propia con JWT ES256 y refresh rotativo](docs/adr/0006-autenticacion-propia.md)
7. [Tiempo real entre réplicas: Redis para avisar, Postgres para no perder nada](docs/adr/0007-tiempo-real-entre-replicas.md)
