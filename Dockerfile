# Pik Dame - Dockerfile
# Lightweight Node.js image, runs as a non-root user.
# Persistent data (player profiles, game history, accounts DB) lives under
# /app/data and should be mounted as a volume (see docker-compose.yml).

FROM node:24-alpine

# Upgrade OS packages first (fixes known CVEs in the base image), then add
# tini for proper signal handling (Ctrl+C / docker stop) as PID 1
RUN apk upgrade --no-cache && apk add --no-cache tini

WORKDIR /app

# Copy only the manifests first -> the Docker layer cache for `npm ci`
# stays valid as long as package*.json does not change.
COPY package.json package-lock.json ./
# Install production deps, then REMOVE the npm/corepack tooling from the
# final image: the server never needs it at runtime, and npm's own
# dependency tree (sigstore, picomatch, ...) regularly carries CVEs that
# would trip the Trivy gate - removing it shrinks the attack surface
# (OWASP: minimal image) and keeps the scan meaningful for OUR code.
RUN npm ci --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
            /root/.npm

COPY server.js ./
COPY game ./game
COPY public ./public

# data/ is normally mounted as a volume; the directory still has to exist
# and must be owned by the unprivileged user.
RUN mkdir -p /app/data \
  && addgroup -S pikdame \
  && adduser -S pikdame -G pikdame \
  && chown -R pikdame:pikdame /app

USER pikdame

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
