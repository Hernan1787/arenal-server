# Arenal — servidor de juego por turnos

Servidor autoritativo del juego **Arenal** para el proyecto 2 de Diseño de Software (TEC, II semestre 2026,
Ing. Jonathan Solís Parajeles). El servidor valida cada jugada, es la única fuente de verdad de la partida y
le manda a cada jugador solo lo que le toca ver.

Equipo: Hernán Alonso Gutiérrez Quesada y José Andrés Acuña Garay.

Las reglas del juego están en [docs/game-rules.md](docs/game-rules.md).

## Estado

| Parte | Estado |
| --- | --- |
| Motor de reglas (`packages/domain`) | Listo, con pruebas unitarias y de propiedades |
| Contrato en tiempo real (`packages/contracts`) | v0: mensajes, errores y códigos de cierre; genera AsyncAPI 3.0 |
| Servidor HTTP (`apps/server`) | Sondas `/health/live` y `/health/ready`, Problem Details, encabezados de seguridad, apagado ordenado |
| Usuarios, salas, emparejamiento | Pendiente |
| WebSocket, turnos con temporizador, reconexión | Pendiente |
| Persistencia en Postgres y difusión por Redis | Pendiente |
| Infraestructura en Azure (Bicep) y despliegue | Pendiente |
| Prueba de carga | Pendiente |

URL pública en Azure: pendiente.

## Correr local (menos de 10 minutos)

Requisitos: Docker con Docker Compose.

```bash
docker compose up --build
curl localhost:8080/health/ready
# {"status":"ready","checks":{"postgres":"ok","redis":"ok"}}
```

Compose levanta Postgres 17, Redis 7.4 y el servidor. No hay contraseñas: Postgres usa autenticación `trust`
y los puertos solo escuchan en `127.0.0.1`.

## Desarrollo

Requisitos: Node 24 (`nvm use`) y pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm test              # todas las pruebas
pnpm lint              # ESLint estricto (sin any, dominio puro)
pnpm typecheck         # TypeScript estricto
pnpm contracts:check   # el contrato AsyncAPI generado está al día con el código

docker compose up -d postgres redis
pnpm dev               # servidor con recarga en http://localhost:8080
```

`pnpm install` activa un hook de pre-commit que corre [gitleaks](https://github.com/gitleaks/gitleaks) si está
instalado. El CI lo corre siempre.

## Estructura

```
packages/domain      motor de reglas puro: decide, evolve, viewFor, projectEvent
packages/contracts   esquemas Zod de los mensajes; genera generated/asyncapi.yaml
apps/server          Fastify: HTTP, sondas, Postgres y Redis
docs/                reglas, decisiones de arquitectura (ADR) y catálogo de errores
.github/             CI (lint, tipos, pruebas, contratos, gitleaks, Trivy), CodeQL y Dependabot
```

El dominio no depende de nada: ni red, ni base de datos, ni framework, ni reloj ni `Math.random`. Una regla
de ESLint y una prueba de arquitectura rompen el build si alguien lo intenta. El azar entra por un puerto
(`Rng`) que en producción usa `crypto.randomInt`.

## Contratos

- **Tiempo real:** [`packages/contracts/generated/asyncapi.yaml`](packages/contracts/generated/asyncapi.yaml),
  generado desde los esquemas Zod con `pnpm contracts:generate`. No se edita a mano.
- **REST:** OpenAPI 3.1 en `/docs` (pendiente, llega con los endpoints de usuarios y salas).
- **Errores HTTP:** Problem Details (RFC 9457). Catálogo en [docs/problems.md](docs/problems.md).

## Decisiones de arquitectura

En [docs/adr](docs/adr):

1. [TypeScript sobre Node 24](docs/adr/0001-typescript-node-24.md)
2. [El dominio decide con eventos y Postgres ordena las jugadas](docs/adr/0002-eventos-y-orden-en-postgres.md)
3. [Azure Managed Redis en lugar de Azure Cache for Redis](docs/adr/0003-azure-managed-redis.md)
4. [WebSocket con `ws` en lugar de Socket.IO](docs/adr/0004-websocket-con-ws.md)
