# syntax=docker/dockerfile:1
# Optional: serve the built SPA with nginx for a one-command local stack (production uses Vercel).
FROM node:22-alpine AS build
WORKDIR /app
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
COPY apps/web apps/web
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w apps/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
