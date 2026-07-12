# Pik Dame - Dockerfile (multi-stage)
# Lightweight Node.js image, runs as a non-root user.
# Persistent data (player profiles, game history, accounts DB) lives under
# /app/data and should be mounted as a volume (see docker-compose.yml).

# --- Stage 1: install production dependencies ------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Optional ONNX runtime for the learned bot policy. It is a ~100 MB native
# dependency, so it is NOT in the default image - the heuristic bots need
# nothing extra. Build an ONNX-capable image with:
#   docker build --build-arg WITH_ONNX=1 -f docker/Dockerfile .
ARG WITH_ONNX=0
RUN if [ "$WITH_ONNX" = "1" ]; then \
      npm install --omit=dev --no-save onnxruntime-node; \
    fi

# --- Stage 2: minimal runtime image -----------------------------------------
FROM node:24-alpine

# OCI labels: link the GHCR package to the repository and document the image
LABEL org.opencontainers.image.source="https://github.com/floriandeutsch89/pikdame-local" \
      org.opencontainers.image.title="Pik Dame" \
      org.opencontainers.image.description="Multiplayer card game server (family rummy variant)" \
      org.opencontainers.image.licenses="UNLICENSED"

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
COPY server.js ./
COPY game ./game
COPY public ./public
# Trained bot policies (~700 KB each). Harmless when unused: without
# PIKDAME_ONNX=1 they are never loaded. Operators who want to swap models
# WITHOUT rebuilding can instead mount them and set PIKDAME_MODELS_DIR.
COPY models ./models

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
