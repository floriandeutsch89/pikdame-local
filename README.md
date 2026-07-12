# ♠ Pik Dame

Multiplayer card game (family rummy variant) for 2–4 players — empty seats
are filled by bots with three difficulty levels. Runs in **two operating
modes** from the same codebase:

**▶ Live demo: [play.pikdame.online](https://play.pikdame.online)** — try it in
your browser (no install needed).

**📚 Documentation: [pik-dame.readthedocs.io](https://pik-dame.readthedocs.io)** —
getting started, admin manual (configuration, backup & restore, ONNX bots),
developer guide, FAQ.

| | 🏕️ On the go (offline) | ☁️ Hosted (online) |
|---|---|---|
| **Where** | iPhone hotspot, CodeApp, no internet required | Your own server / Raspberry Pi / Kubernetes |
| **For whom** | Family round at the table | Playing across distances, e.g. `spiel.pikdame.online` |
| **Extras** | — | User accounts with e-mail confirmation, protected names |
| **Start** | [iPhone + CodeApp](#-iphone-hotspot-codeapp) | [Docker / Helm](#-hosted-docker) |

Bilingual (German/English), installable as a PWA, no build step and no
external frontend dependencies.

---

## Features

- **Bots with character**: three difficulties (Anfänger → Zen with card counting),
  human names (Uwe, Inge, Maria …) and random emote reactions — including the
  occasional Queen-of-Spades bluff.
- **Statistics & achievements**: player profiles (games/wins/points/streaks),
  8 unlockable badges, global server counters, round statistics and a JSON
  game-history export.
- **User accounts** (hosted mode only): registration with e-mail
  confirmation, login with a 90-day session — your name is protected against
  impersonation and your progress is kept permanently. Stored in
  **PostgreSQL** in the Docker/K8s stack (SQLite as zero-config fallback for
  a single container); automatically disabled and invisible in hotspot mode.
- **Robust in operation**: reconnect with bot takeover, running games survive
  server restarts (session snapshot), heartbeat against zombie connections,
  armored error handling on client and server.
- **Three design themes** (table/night/queen-of-hearts), card fan, synthesized
  sound (offline-capable, no audio files), haptics.
- **Tutorial mode** for first-time players: contextual hints explain each
  rule the moment it becomes relevant during a real game against easy bots
  (fully client-side, works offline).

## Quick start

### ☁️ Hosted (Docker)

```sh
# Full production stack (Caddy TLS/ACME -> app -> PostgreSQL):
cd docker && cp .env.example .env   # set PIKDAME_DOMAIN + ACME_EMAIL
echo -n 'strong-pw' > secrets/db_password.txt
docker compose -f docker-compose.prod.yml up -d
# → https://<your-domain>

# Or minimal without a domain (prebuilt image, amd64 + arm64):
docker compose -f docker/docker-compose.ghcr.yml up -d   # → http://<host>:8080
```

Or on Kubernetes via Helm (the chart is published as an OCI artifact with
every release):

```sh
helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame \
  --version <X.Y.Z> --set ingress.host=spiel.example.org --set image.tag=v<X.Y.Z>
```

Everything else — updates, rollback, backup, secrets, TLS — lives in the
**[operations guide](https://pik-dame.readthedocs.io/en/latest/admin/operations.html)**
(and [backup & restore](https://pik-dame.readthedocs.io/en/latest/admin/backup-restore.html),
which is worth rehearsing before you need it); security (OWASP hardening,
CI scans) in **[SECURITY.md](SECURITY.md)**; Kubernetes details in
**[k8s/README.md](k8s/README.md)**. The selection page for a domain hosting
multiple apps lives under **[landing/](landing/README.md)**.

### 💻 Local

```sh
npm install && npm start
# → http://localhost:8080
```

### 🏕️ iPhone hotspot (CodeApp)

1. Load the project into CodeApp (git clone in the built-in terminal or file
   import), then: `npm install && node server.js`.
   On startup the server lists all reachable network IPs and marks Apple's
   hotspot range (`172.20.10.x`).
2. Enable the personal hotspot. **Note:** iOS requires an active cellular/SIM
   connection for this — without reception (airplane, abroad without a data
   plan) the hotspot often won't start at all. Alternatives: a fellow
   player's Android hotspot, a travel router, or a shared Wi-Fi network.
3. Players connect to the hotspot and open the displayed IP in their browser
   (e.g. `http://172.20.10.1:8080`) — the client discovers the host
   automatically, no code change needed.

**⚠️ CodeApp must stay in the foreground.** iOS suspends the Node process as
soon as the app goes to the background or the display locks (a fundamental
iOS limitation). Therefore: set auto-lock to "Never" (Settings → Display &
Brightness) or use **Guided Access** (Accessibility) — it pins the screen to
CodeApp. If something unexpected happens anyway, it ends up in
`data/crash.log`.

## Game sessions

Every game gets a **cryptographically random 6-character code** (no
confusable characters) — only those who know it can join; there is
deliberately no game list. The code can be shared via the iOS share sheet or
a link (`?session=CODE`). Any number of games run in parallel and fully
isolated; reconnects find their way back to the right table via the stored
player ID.

## Game rules

The full rules live **inside the app** (📖 button, DE/EN). Key points and
where they are implemented:

| Rule | File |
|---|---|
| 110 cards (2×52 + 6 jokers), 15 hand cards | `Deck.js` |
| Draw: pile OR discard pile in two phases (top card must be melded immediately, then the rest follows) | `GameManager.js` |
| Sets (same rank, each suit max 2×) and runs on the rank ring (K-A-2 valid, max 13) | `Rules.js` |
| Only ONE set per rank per player; laying off & joker swaps only on YOUR OWN melds | `GameManager.js` |
| Lucky cut (Queen of Spades/joker at the cut position) | `Deck.js` |
| Swapped jokers are permanently out of the game (cannot be picked up again) | `GameManager.js` |
| **Going out only by discarding the last card** | `GameManager.js` |
| Points: 2–9 = 5 · 10/J/Q/K = 10 · Ace/Joker = 20 · ♠Q = 100; game ends at 1000 | `Card.js`, `ScoreBoard.js` |

**House rules** (selectable at game start): "hand aus counts double",
"more than 1000 to win", bot difficulty (Anfänger / Fortgeschritten / Zen).

<details>
<summary><b>Deliberate rule interpretations</b></summary>

1. **Runs are circular**: ranks form a ring (…Q-K-A-2-3…), max 13 cards per
   run (`Rules.js`, `RANK_ORDER`).
2. **Joker swap timing**: only during your own melding phase; the freed joker
   is out for the rest of the round.
3. **Bots are heuristics**, not a solver — rule-abiding, table-aware, and they
   never voluntarily discard a joker (except as the winning discard of the
   last card).
4. **"Hand aus"** = the round ends within the very first turn, regardless of
   who starts.
5. For **ambiguous joker combinations** the game asks via an overlay instead
   of guessing (`enumerateMeldOptions` in `Rules.js`).
</details>

## Fairness & card dealing

**How are the cards dealt?** Before every round a **brand-new, full 110-card
deck** (2 decks + 6 jokers) is created and shuffled with the **Fisher-Yates**
algorithm (`shuffle()` in `game/Deck.js`), then dealt **round-robin** — one card
at a time to each player in turn, exactly like dealing by hand — until everyone
holds 15 cards. Nothing is carried over from the previous round.

**Is it just random?** Yes — and deliberately so. Fisher-Yates is the standard
unbiased shuffle: every possible card order is **equally likely**, so every
player has the **same chance** at the Queen of Spades, jokers and other strong
cards in every round. No seat and no player is favoured.

**How do you stop one player from getting all the good cards?** We don't — and
we shouldn't. There is **no hand-balancing or rigging**; "fixing" hands would
itself be unfair and is not how real card games work. Fairness comes from the
**uniform distribution**: in a single round someone may get lucky (that's part
of the game), but over many rounds it evens out and nobody has a systematic
edge. The randomness source is the runtime's `Math.random` (plenty for a card
game — this is about fairness, not cryptography). The **daily challenge** instead
uses a seeded deterministic PRNG (`mulberry32`) so **everyone worldwide gets the
identical deck** — fairness there through identical conditions for all.

## Features in detail

- **Lobby**: player count 2–4, seating order via ▲▼, dealer selectable via ⭐,
  saved teams, forfeit the round via 🏳️ (no winner bonus).
- **Round end**: result overlay with a statistics table (melded cards, ♠Q and
  🃏 per player), score-history chart, badge celebration; rematch keeps
  seating and names.
- **Design**: three themes, glass panels, card fan with a highlighted Queen of
  Spades, green border on cards you personally placed (tracked per card
  slot). System font stack and Web Audio synthesis keep everything
  offline-capable.
- **Bilingual**: German is the source language; English is translated
  client-side via `public/i18n.js` (static texts, dynamic `L(de, en)` and
  regex patterns for server messages — covered by contract tests).

## Operations

The server deliberately speaks plain HTTP — for public hosting put a reverse
proxy with TLS in front (Caddy/nginx examples in
[landing/README.md](landing/README.md)); the client switches to `wss:`
automatically. Important environment variables (all opt-in; without them the
server runs exactly like in hotspot mode):

| Variable | Purpose |
|---|---|
| `PIKDAME_MAX_SESSIONS` | Cap on parallel games (default 200) |
| `PIKDAME_PUBLIC_MODE=1` | Disables profiles/teams/statistics — for servers with strangers |
| `PIKDAME_TRUST_PROXY=1` | Client IP from `X-Forwarded-For` (behind a reverse proxy) |
| `PIKDAME_ALLOWED_ORIGIN` | WebSocket only from your own domain |
| `PIKDAME_ACCOUNTS=0` | Disable user accounts |
| `PIKDAME_DATABASE_URL` | PostgreSQL for accounts (compose sets it; without it: SQLite fallback) |
| `PIKDAME_BASE_URL`, `PIKDAME_SMTP_*` | Confirmation e-mails (see `.env.example`) |

Built-in hardening: name sanitizing + HTML escaping (double XSS protection),
IP-based brute-force protection on codes and the account API, rate limits,
16 KB message limit, session cleanup, heartbeat, graceful shutdown with
session snapshot, atomic persistence, SQLite in WAL mode, scrypt passwords.
Observability via `GET /statusz` (version, sessions, memory — no names) and
`GET /healthz`.

## Development

```
server.js          HTTP + WebSocket, account API, session registry
game/              Pure game logic (Rules, GameManager, Bot, stores, …)
game/StateEncoder  · game/OnnxPolicy — learned-bot encoder + ONNX inference
public/            Vanilla JS client, i18n, PWA
python/ · scripts/rl-env-server.js  RL training bridge (see docs/RL_TRAINING.md)
test/              node --test — 239 tests incl. contract, E2E and encoder tests
helm/ · k8s/       Kubernetes (chart recommended, raw manifests as alternative)
docs/ · scripts/   Operations guide, backup/restore
```

- **Tests**: `npm test` (Node's built-in runner, zero test dependencies). CI
  runs exactly the same — plus dependency audit, Dockerfile lint, Trivy scan,
  Helm validation and a smoke test that boots the fully hardened compose
  configuration. Everything on Node 24.
- **Releases are automated**: bump the version in `package.json` + write the
  CHANGELOG section → on push to `main` the workflow creates the git tag, the
  GitHub release (notes from the CHANGELOG), the multi-arch image and the
  Helm chart on GHCR.
- **Conventions** (language, constraints, workflow): [CLAUDE.md](CLAUDE.md).
  Most important rule: no new npm dependencies — the server must keep running
  inside iOS CodeApp (currently the only dependency: `ws`).

## AI bots (optional, ONNX)

The strong bot tiers (`medium`, `zen`) can be trained as neural networks and run
via ONNX; `easy` stays the hand-written heuristic. Training happens against the
**real engine** — a headless Node env server drives the actual `GameManager`
while Python (Gymnasium + stable-baselines3 MaskablePPO) learns the **draw** and
**discard** decisions; the same `game/StateEncoder.js` feeds both training and
runtime so they never diverge. The policy can also be warm-started from
**winning human games** (anonymised move logging + behavioral cloning). Models
export to `models/pikdame-<tier>.onnx` and are committed to the repo, so anyone
can run them.

```bash
# activate the learned policy (falls back to the heuristic if a model or the
# onnxruntime-node runtime is missing — the default path is unchanged):
PIKDAME_ONNX=1 node server.js
```

Full training guide (Ubuntu 24.04 / WSL2, uv, RTX-class GPU) and — importantly —
**[how to read the training output](https://pik-dame.readthedocs.io/en/latest/developer/rl-training.html)**:
what `approx_kl`, `explained_variance` & co. mean, and why the mean episode
reward is negative even for a *good* model.

Deploying the trained bots:
**[ONNX bots](https://pik-dame.readthedocs.io/en/latest/admin/onnx.html)** — the
default image cannot run them (Alpine/musl vs. glibc), so a second image is
published: `ghcr.io/floriandeutsch89/pikdame-local-onnx`.

## Deliberate limits

- **A single server instance by design**: sessions live in process memory and
  the accounts DB is local SQLite — scaling out would split players across
  instances that know nothing about each other. For the purpose (family and
  friends rounds, 200-session cap) one instance is plenty; the session
  snapshot bridges updates.
- Without accounts, profiles are matched by name (case-insensitive); with
  accounts enabled, verified names are login-protected.
