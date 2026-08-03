# syntax=docker/dockerfile:1

# Builds the static client bundle and serves it with nginx.
#
# `VITE_SERVER_URL` is baked in at build time because Vite inlines `import.meta.env`
# values. Point it at the public origin of the game server, e.g.
#   docker build --build-arg VITE_SERVER_URL=https://play.example.com -f apps/client/Dockerfile .

FROM node:22-alpine AS builder
WORKDIR /app

ARG VITE_SERVER_URL=""
ENV VITE_SERVER_URL=$VITE_SERVER_URL

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/client/package.json ./apps/client/
COPY tests/package.json ./tests/

RUN pnpm install --frozen-lockfile --filter @riftfront/client... --filter @riftfront/shared...

COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY apps/client ./apps/client

RUN pnpm --filter @riftfront/client build

# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/apps/client/dist /usr/share/nginx/html
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
