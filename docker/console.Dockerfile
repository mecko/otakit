# syntax=docker/dockerfile:1.7
#
# OtaKit console (dashboard + API). Built from the repository root:
#   docker build -f docker/console.Dockerfile .
# CI publishes it to GHCR (.github/workflows/docker.yml); docker/compose.yaml runs it.
#
# One image serves two commands: the default `next start`, and the migration
# command that docker/compose.yaml runs before the console starts.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
# openssl: Prisma's query engine links against libssl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
# Matches "packageManager" in the root package.json.
RUN npm install -g pnpm@9.0.0
WORKDIR /app
COPY . .

# Only the console, its workspace dependencies, and the root (the llms.txt
# generator that runs during the build needs the root's typescript).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --filter "@otakit/console..." --filter otakit

# NEXT_PUBLIC_* values are inlined into the bundle at build time, so the image
# is built for one console origin. The default matches docker/compose.yaml.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

# The placeholder secret only lets Better Auth initialise while Next.js collects
# page data; it is scoped to this RUN and never stored in the image.
RUN BETTER_AUTH_SECRET=build-only-placeholder-not-a-secret \
  pnpm --filter @otakit/console build \
  && rm -rf packages/console/.next/cache

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp
# Owned by root and not writable by the app user: a compromised process cannot
# change the code it runs. Next.js writes only to .next/cache (a tmpfs in compose).
COPY --from=build /app /app
RUN mkdir -p /app/packages/console/.next/cache \
  && chown node:node /app/packages/console/.next/cache
WORKDIR /app/packages/console
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health?db=true').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
