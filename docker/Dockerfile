# Pik Dame - Dockerfile (multi-stage)
# Lightweight Node.js image, runs as a non-root user.
# Persistent data (player profiles, game history, accounts DB) lives under
# /app/data and should be mounted as a volume (see docker-compose.yml).

# --- Stage 1: install production dependencies ------------------------------
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm cache as a BuildKit cache mount (/root/.npm is npm's cache dir in this
# image). Keeps the download out of the layer and out of the network on every
# rebuild. Same caveat as the Caddy image: mounts live on the BUILDER, so a
# GitHub-hosted runner starts empty and only local/self-hosted builds gain.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev


# --- Stage 2: minify the browser assets ------------------------------------
# Only the IMAGE ships minified files. The repository keeps readable sources
# because the hotspot/CodeApp mode serves public/ straight from the checkout
# and has to stay build-free (see CLAUDE.md).
# $BUILDPLATFORM keeps this stage on the native builder: the output is plain
# text and byte-identical for every target architecture, so running it under
# QEMU for the arm64 image would only cost minutes.
# hadolint ignore=DL3029
FROM --platform=$BUILDPLATFORM node:26-alpine AS assets
WORKDIR /app
# Full install (esbuild is a devDependency); nothing from here reaches the
# runtime image - only the minified files under public/ do.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY scripts/minify-assets.js ./scripts/
COPY public ./public
RUN node scripts/minify-assets.js

# --- Stage 3: minimal runtime image -----------------------------------------
FROM node:26-alpine

# OCI labels: link the GHCR package to the repository and document the image
LABEL org.opencontainers.image.source="https://github.com/floriandeutsch89/pikdame-local" \
      org.opencontainers.image.title="Pik Dame" \
      org.opencontainers.image.description="Multiplayer card game server (family rummy variant)" \
      org.opencontainers.image.licenses="MIT"

# Upgrade OS packages (fixes known CVEs in the base image), add tini for
# proper signal handling as PID 1, and REMOVE the npm/corepack tooling:
# the server never needs it at runtime, and npm's own dependency tree
# regularly carries CVEs that would trip the Trivy gate (OWASP: minimal image).
RUN apk upgrade --no-cache \
  && apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
            /root/.npm

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY CHANGELOG.md ./
# MIT requires the licence text to travel with every copy of the software -
# and a container image is a copy.
COPY LICENSE ./
COPY server.js ./
COPY game ./game
# Minified in stage "assets" - index.html travels through untouched, because
# its inline script is pinned by sha256 in the production CSP.
COPY --from=assets /app/public ./public

# data/ is normally mounted as a volume; the directory still has to exist
# and must be owned by the unprivileged user.
# Fixed UID/GID (10001): compose file secrets are bind mounts that keep the
# HOST file's owner/mode - a deterministic UID lets the host chown the
# secret files so the non-root app user can read them (chown 10001, mode 400).
RUN mkdir -p /app/data \
  && addgroup -S -g 10001 pikdame \
  && adduser -S -u 10001 -G pikdame pikdame \
  && chown -R pikdame:pikdame /app

USER pikdame

ENV PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
