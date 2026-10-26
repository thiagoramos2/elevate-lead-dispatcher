# syntax=docker/dockerfile:1.7
# Contexto de build: raiz do repositório (ver docker-compose.yml).

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependências (em cache até um manifest ou o lockfile mudar) ----------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter web...

# --- build ---------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# As rewrites de /api/* são resolvidas no build: aponta para o serviço `api` da rede do Compose.
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @elevate/contracts build && pnpm --filter web build

# --- runtime: servidor standalone do Next (só o necessário para rodar) ------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
