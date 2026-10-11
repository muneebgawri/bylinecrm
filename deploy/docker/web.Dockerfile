# syntax=docker/dockerfile:1
#
# BylineCRM web image (P5-4a): the Vite production build served by nginx, which also forwards
# `/api` and `/health` to the `api` service on the stack's internal network. Base images from the
# ECR Public mirror (see api.Dockerfile).

# node:22-bookworm-slim and nginx:1.27-alpine, mirrored by digest (deploy/images/mirror.json, #123).
ARG NODE_IMAGE=ghcr.io/muneebgawri/mirror/node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG NGINX_IMAGE=ghcr.io/muneebgawri/mirror/nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Only the web app and the workspace packages it uses (shared, ui) — not the API's dependencies.
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm --filter @bylinecrm/shared build && pnpm --filter web build

FROM ${NGINX_IMAGE} AS runtime
COPY deploy/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
