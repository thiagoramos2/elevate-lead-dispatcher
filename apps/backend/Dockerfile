# syntax=docker/dockerfile:1.7
# Contexto de build: raiz do repositório (ver docker-compose.yml).

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependências (em cache até um manifest ou o lockfile mudar) ----------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/contracts/package.json packages/contracts/
# Scripts são pulados: o código-fonte ainda não foi copiado. Deps nativas (argon2) vêm pré-compiladas.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter backend...

# --- build ---------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/backend apps/backend
RUN pnpm --filter @elevate/contracts build && pnpm --filter backend build

# --- migrator: aplica as migrations e (opcionalmente) o seed de demonstração, e termina ------
FROM build AS migrator
WORKDIR /app/apps/backend
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && if [ \"$SEED_DEMO_DATA\" = \"true\" ]; then pnpm exec prisma db seed; fi"]

# --- somente dependências de produção ------------------------------------------------------
FROM build AS prod-deps
RUN pnpm --filter backend deploy --legacy --prod /out

# --- runtime: api e worker compartilham esta imagem, com comandos diferentes ---------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /out/node_modules ./node_modules
COPY --from=prod-deps /out/package.json ./package.json
COPY --from=build /app/apps/backend/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/api.js"]
