# syntax=docker/dockerfile:1.7
# Build context: repository root (see docker-compose.yml).

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependencies (cached until a manifest or the lockfile changes) -------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/contracts/package.json packages/contracts/
# Scripts are skipped: sources are not copied yet. Native deps (argon2) ship prebuilt binaries.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter backend...

# --- build ---------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/backend apps/backend
RUN pnpm --filter @elevate/contracts build && pnpm --filter backend build

# --- migrator: applies migrations and (optionally) demo seed, then exits --------------------
FROM build AS migrator
WORKDIR /app/apps/backend
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && if [ \"$SEED_DEMO_DATA\" = \"true\" ]; then pnpm exec prisma db seed; fi"]

# --- production dependencies only -----------------------------------------------------------
FROM build AS prod-deps
RUN pnpm --filter backend deploy --legacy --prod /out

# --- runtime: api and worker share this image, with different commands --------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /out/node_modules ./node_modules
COPY --from=prod-deps /out/package.json ./package.json
COPY --from=build /app/apps/backend/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/api.js"]
