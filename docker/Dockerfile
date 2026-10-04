# Pik Dame - Dockerfile (multi-stage), the ONE image.
# Debian slim + Node, runs as a non-root user, trained ONNX bots built in.
# Persistent data (player profiles, game history, accounts DB) lives under
# /app/data and should be mounted as a volume (see docker-compose.yml).
#
# Bots: the learned policies (onnxruntime-node + models/) are active by
# default (PIKDAME_ONNX=1). PIKDAME_ONNX=0 switches to the heuristic engine;
# if the runtime or a model cannot load, the server falls back to the
# heuristic by itself and says so in the log.
#
# Why Debian and not Alpine: onnxruntime-node ships pre-built binaries linked
# against glibc. On Alpine (musl) the install "succeeds" and the require()
# fails - ONNX would silently never work.

# --- Stage 1: production dependencies + the ONNX runtime --------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node is installed HERE, not in package.json: the repository has
# no native dependency (the hotspot/CodeApp mode runs `node server.js` from the
# checkout and plays heuristic bots there). PINNED on purpose (hadolint
# DL3016): a native runtime must not change silently between builds.
#
# Then everything the server never loads goes:
# - adm-zip + global-agent: only used by onnxruntime-node's postinstall
#   download; adm-zip 0.5.x carries several HIGH CVEs.
# - binaries for other systems (darwin, win32) and the other CPU architecture.
# - the CUDA/TensorRT GPU providers (~240 MB) - inference runs on the CPU.
# 503 MB -> 41 MB of node_modules.
#
# npm cache as a BuildKit cache mount (/root/.npm is npm's cache dir in this
# image). Mounts live on the BUILDER, so a GitHub-hosted runner starts empty
# and only local/self-hosted builds gain.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
  && npm install --omit=dev --no-save onnxruntime-node@1.27.0 \
  && rm -rf node_modules/adm-zip node_modules/global-agent \
  && ORT=node_modules/onnxruntime-node/bin/napi-v6 \
  && ARCH=$(node -p process.arch) \
  && find "$ORT" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
  && find "$ORT/linux" -mindepth 1 -maxdepth 1 ! -name "$ARCH" -exec rm -rf {} + \
  && rm -f "$ORT"/linux/*/libonnxruntime_providers_cuda.so \
           "$ORT"/linux/*/libonnxruntime_providers_tensorrt.so \
  && { test -f "$ORT/linux/$ARCH/onnxruntime_binding.node" \
       || { echo "no onnxruntime binding for linux/$ARCH - the image would ship without trained bots" >&2; exit 1; }; }


# --- Stage 2: minify the browser assets ------------------------------------
# Only the IMAGE ships minified files. The repository keeps readable sources
# because the hotspot/CodeApp mode serves public/ straight from the checkout
# and has to stay build-free (see CLAUDE.md).
# $BUILDPLATFORM keeps this stage on the native builder: the output is plain
# text and byte-identical for every target architecture, so running it under
# QEMU for the arm64 image would only cost minutes.
# hadolint ignore=DL3029
FROM --platform=$BUILDPLATFORM node:26-slim AS assets
WORKDIR /app
# Full install (esbuild is a devDependency); nothing from here reaches the
# runtime image - only the minified files under public/ do.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY scripts/minify-assets.js ./scripts/
COPY public ./public
RUN node scripts/minify-assets.js

# --- Stage 3: runtime image --------------------------------------------------
FROM node:26-slim

# OCI labels: link the GHCR package to the repository and document the image
LABEL org.opencontainers.image.source="https://github.com/floriandeutsch89/pikdame-local" \
      org.opencontainers.image.title="Pik Dame" \
      org.opencontainers.image.description="Multiplayer card game server (family rummy variant) with trained ONNX bots" \
      org.opencontainers.image.licenses="MIT"

# Security updates of the base packages (node:*-slim lags behind Debian's
# fixes by days - Trivy found fixed openssl/pcre2 HIGH CVEs), tini for proper
# signal handling as PID 1, and REMOVE the npm/corepack tooling: the server
# never needs it at runtime, and npm's own dependency tree regularly carries
# CVEs that would trip the Trivy gate (OWASP: minimal image).
# Fixed UID/GID (10001): compose file secrets are bind mounts that keep the
# HOST file's owner/mode - a deterministic UID lets the host chown the
# secret files so the non-root app user can read them (chown 10001, mode 400).
# Only data/ is writable for that user: the root filesystem runs read-only,
# and a recursive chown of /app would copy node_modules into a second layer.
# hadolint ignore=DL3005,DL3008
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
            /root/.npm \
  && groupadd -g 10001 pikdame \
  && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin pikdame \
  && mkdir -p /app/data \
  && chown pikdame:pikdame /app/data

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
# The trained policies (~700 KB each). Swap them without rebuilding by mounting
# a directory and setting PIKDAME_MODELS_DIR.
COPY models ./models

USER pikdame

ENV PORT=8080 \
    NODE_ENV=production \
    PIKDAME_ONNX=1
EXPOSE 8080

# Debian slim has no wget; use node itself for the health check.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
