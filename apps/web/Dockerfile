# Production image for the GCS web client. Multi-stage: build the Vite bundle with
# node, then serve the static dist/ from nginx. nginx also enforces HTTP Basic Auth
# (the deploy's front door — Render has no built-in middleware/password gate).
#
# Vite bakes VITE_* into the bundle at BUILD time, so the gateway location + mapbox
# token come in as build args (render.yaml passes them from the service's env vars).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_MAPBOX_TOKEN
ARG VITE_GATEWAY_HOST
ARG VITE_WS_URL
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN \
    VITE_GATEWAY_HOST=$VITE_GATEWAY_HOST \
    VITE_WS_URL=$VITE_WS_URL
RUN npm run build

FROM nginx:alpine
# htpasswd (apache2-utils) generates the Basic Auth file from env at container start.
RUN apk add --no-cache apache2-utils
# listen ${PORT}; nginx:alpine envsubst's *.template -> conf.d/ before boot. Default so
# the image runs standalone; Render sets PORT at runtime.
ENV PORT=8080
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
# runs before nginx (nginx image execs /docker-entrypoint.d/*.sh); writes .htpasswd.
COPY nginx/40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh
RUN chmod +x /docker-entrypoint.d/40-basic-auth.sh
COPY --from=build /app/dist /usr/share/nginx/html
