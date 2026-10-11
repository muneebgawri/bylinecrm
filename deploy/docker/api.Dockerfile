# syntax=docker/dockerfile:1
#
# BylineCRM API image (P5-4a). One image serves two services in deploy/staging/docker-compose.yml:
# `api` (the default command) and the one-shot `migrate` (app-role setup + `prisma migrate deploy`).
#
# Base images come from the ECR Public mirror of Docker's official library: Docker Hub's anonymous
# pull limit has blocked CI here before (#79).

# node:22-bookworm-slim, mirrored by digest (deploy/images/mirror.json, #123).
ARG NODE_IMAGE=ghcr.io/muneebgawri/mirror/node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS base
# Prisma's engines link against OpenSSL; the slim image ships without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bylinecrm/shared build \
    && pnpm --filter api exec prisma generate \
    && pnpm --filter api build
# A production-only copy of the api package with its workspace dependency injected; `prisma` and
# `pg` are runtime dependencies because the migrate service runs them.
RUN pnpm --filter api deploy --prod /out \
    && cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma \
    && mkdir -p /out/scripts && cp /repo/scripts/db-ensure-app-role.mjs /out/scripts/ \
    && rm -rf /out/src /out/test /out/contract /out/*.mts /out/eslint.config.mjs /out/tsconfig*.json /out/nest-cli.json

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
