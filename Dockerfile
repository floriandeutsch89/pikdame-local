# Pik Dame - Dockerfile
# Leichtgewichtiges Node.js-Image, läuft als nicht-root User.
# Persistente Daten (Spielerprofile/Teams/Spielverlauf) liegen unter /app/data
# und sollten über ein Volume gemountet werden (siehe docker-compose.yml).

FROM node:22-alpine

# tini sorgt für sauberes Signal-Handling (Ctrl+C / docker stop) bei PID 1
RUN apk add --no-cache tini

WORKDIR /app

# Nur Manifest zuerst kopieren -> Docker-Layer-Cache für npm ci bleibt erhalten,
# solange sich package*.json nicht ändert.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY game ./game
COPY public ./public

# data/ wird normalerweise als Volume gemountet; Verzeichnis muss trotzdem
# existieren und dem unprivilegierten User gehören.
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
