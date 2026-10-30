# syntax=docker/dockerfile:1.7

# --- Compilación ------------------------------------------------------------------------
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# Primero solo los manifiestos, para aprovechar la caché de dependencias.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY apps/server apps/server
# --filter-prod: compila el servidor y sus dependencias de producción, no las de desarrollo
# (el cliente de pruebas no entra a la imagen).
# --ignore-scripts: la imagen no ejecuta scripts de instalación (ni los del repo, como
# `prepare`, que necesita archivos que no entran al contexto de Docker).
RUN pnpm --filter-prod "@arenal/server..." build \
 && pnpm --filter @arenal/server deploy --prod --legacy --ignore-scripts /out

# --- Imagen final -------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Corre como usuario sin privilegios (requisito del proyecto).
USER node
EXPOSE 8080
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
# instrument.js arranca OpenTelemetry antes que el servidor (solo si hay conexión con App Insights).
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
