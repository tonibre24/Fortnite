# syntax=docker/dockerfile:1

# Multi-stage build for the Project Riftfront game server.
#
# Stage 1 installs the whole workspace (the server depends on the shared package via a
# workspace link) and builds both packages. Stage 2 keeps only production dependencies
# and the compiled output, so the shipped image carries no toolchain.

FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable

# Manifests first: this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/client/package.json ./apps/client/
COPY tests/package.json ./tests/

# The client and test workspaces are not needed to build the server image.
RUN pnpm install --frozen-lockfile --filter @riftfront/server... --filter @riftfront/shared...

COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

RUN pnpm --filter @riftfront/shared build \
 && pnpm --filter @riftfront/server build

# Strip dev dependencies from the tree that will be copied forward.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=2567 \
    HOST=0.0.0.0

# Run unprivileged; the node image already provides the `node` user.
RUN apk add --no-cache tini

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/
COPY --from=builder --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules

USER node
EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM so the server's graceful shutdown runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
