# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/api/Dockerfile -t nse-api .

# ---------- 1. build: full install (dev deps) + TypeScript compile ----------
FROM node:22-alpine AS build
WORKDIR /app
# Manifests first so the dependency layer is cached until a package.json/lockfile changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# Optional extra CA (TLS-intercepting corporate proxies): docker build --secret id=extra_ca,src=ca.pem ...
# Mounted only for this step, never stored in a layer; without it NODE_EXTRA_CA_CERTS points nowhere and is ignored.
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/api apps/api
RUN npx tsc -b apps/api

# ---------- 2. prod-deps: runtime dependencies only ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci --omit=dev --ignore-scripts --workspace @nse/api && npm cache clean --force

# ---------- 3. runtime: small image, non-root ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=4000 SERVICE_NAME=api
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/packages/core/package.json packages/core/
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/migrations packages/core/migrations
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
# The official image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "apps/api/dist/server.js"]
