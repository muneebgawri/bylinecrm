# syntax=docker/dockerfile:1
#
# BylineCRM web image (P5-4a): the Vite production build served by nginx, which also forwards
# `/api` and `/health` to the `api` service on the stack's internal network. Base images from the
# ECR Public mirror (see api.Dockerfile).

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
ARG NGINX_IMAGE=public.ecr.aws/docker/library/nginx:1.27-alpine

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
