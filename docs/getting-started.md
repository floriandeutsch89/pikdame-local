# Getting started

Three ways to run it, from "one command" to "production with TLS".

## 1. Quickest: a single container

Prebuilt images are published to GitHub Container Registry (amd64 + arm64):

```bash
docker run -d --name pikdame \
  -p 8080:8080 \
  -v pikdame-data:/app/data \
  ghcr.io/floriandeutsch89/pikdame-local:latest
```

Open <http://localhost:8080>. That's it — no accounts, no database, no config.

:::{important}
Always mount a volume at `/app/data`. Everything persistent lives there
(profiles, statistics, game history, accounts, and the snapshot that lets running
games survive a restart). Without it, all of that is lost on every restart.
:::

## 2. Production: Docker Compose with automatic TLS

The full stack is Caddy (TLS/ACME) → app → PostgreSQL. Caddy obtains and renews
certificates from Let's Encrypt automatically; you only need a domain pointing at
the host.

### Prerequisites

- A host with Docker and the Compose plugin.
- **DNS**: an `A` record (and `AAAA` if you have IPv6) for your domain pointing
  at the host's public IP. ACME will not work before DNS resolves.
- **Ports 80 and 443 reachable** from the internet. Port 80 is required for the
  ACME HTTP challenge — don't firewall it away.

### Configure

```bash
git clone https://github.com/floriandeutsch89/pikdame-local.git
cd pikdame-local/docker
cp .env.example .env
```

Edit `.env`:

```bash
# The domain Caddy should obtain a certificate for
PIKDAME_DOMAIN=play.example.com
# The address Let's Encrypt uses for expiry warnings
ACME_EMAIL=you@example.com
# Database password (or use a Docker secret, see below)
POSTGRES_PASSWORD=<a long random string>
```

### Start

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

Caddy will request a certificate on first start. Watch it happen:

```bash
docker compose -f docker-compose.ghcr.yml logs -f caddy
```

Then open `https://play.example.com`.

:::{tip}
**ACME troubleshooting.** If the certificate does not arrive, it is almost always
one of three things: DNS not resolving yet (`dig +short play.example.com`), port
80 blocked, or Let's Encrypt rate limits after repeated failed attempts. For
testing, point Caddy at the *staging* ACME endpoint first so you don't burn the
rate limit.
:::

### Secrets

Any secret can be supplied as a file instead of an environment variable — append
`_FILE` and point it at the path (Docker secrets):

```yaml
environment:
  - PIKDAME_DATABASE_PASSWORD_FILE=/run/secrets/db_password
secrets:
  - db_password
```

See {doc}`admin/configuration` for every variable.

## 3. Kubernetes

There is no Helm chart (deliberately — the app is one stateless container plus a
volume), but the deployment is straightforward:

- **Deployment**: one replica of the image.
  :::{warning}
  Do **not** scale beyond one replica. Game state lives in the process's memory;
  two replicas would each hold different tables and players would land on the
  wrong one. To scale out you would need session affinity *and* a shared store —
  see {doc}`faq`.
  :::
- **PersistentVolumeClaim** mounted at `/app/data` (ReadWriteOnce is fine).
- **Service** on port 8080, **Ingress** with WebSocket support enabled and TLS
  from cert-manager (which handles ACME the same way Caddy does).
- Set `PIKDAME_TRUST_PROXY=1` so client IPs are read from `X-Forwarded-For`.
- Want the **trained ONNX bots**? Use the chart overrides in
  `helm/pikdame/values-onnx.yaml` — see {doc}`admin/onnx`.

:::{important}
The ingress must not buffer or time out WebSocket connections. On nginx-ingress,
raise `proxy-read-timeout`/`proxy-send-timeout` well above the game's heartbeat
interval (30 s by default), or connections will be cut mid-game.
:::

The container runs as a **non-root user (UID 10001)**. If your storage class
creates the volume owned by root, the app cannot write and will say so loudly in
its logs on startup. Set `fsGroup: 10001` in the pod's security context.

## 4. Local development

```bash
git clone https://github.com/floriandeutsch89/pikdame-local.git
cd pikdame-local
npm install
npm start          # → http://localhost:8080
npm test           # the full suite
```

No build step: edit `public/client.js` and reload the page.

## Next steps

- {doc}`admin/configuration` — every environment variable
- {doc}`admin/backup-restore` — don't skip this one
- {doc}`developer/index` — how the pieces fit together
