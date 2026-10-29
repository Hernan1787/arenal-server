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
RUN pnpm --filter "@arenal/server..." build \
 && pnpm --filter @arenal/server deploy --prod --legacy /out

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
CMD ["node", "dist/main.js"]
