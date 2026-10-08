# Shared Caddy (reverse proxy)

Production runs behind the host's **shared Caddy stack**,
[caddy-crowdsec](https://github.com/floriandeutsch89/caddy-crowdsec): one Caddy
for every site on the server, with CrowdSec, the AppSec WAF, per-IP rate limits
and Watchtower. The Pik Dame stack (`docker/docker-compose.prod.yml`) only runs
the app, PostgreSQL and the SMTP egress proxy, and joins Caddy through one
network:

```
internet ── caddy_egress ── caddy ── caddy_play_pikdame ── pikdame ── pikdame ── postgres
                                                              └─ pikdame_smtp ── smtp-egress ── pikdame_egress ── Mailgun
```

## What lives where

| | Shared Caddy stack (`/opt/caddy`) | Pik Dame stack (`/opt/pikdame/docker`) |
| --- | --- | --- |
| TLS / ACME, HTTP/3 | yes | – |
| CrowdSec, AppSec, rate limit, access log (48 h) | `import common` | – |
| CSP, HSTS, COOP, `X-Frame-Options`, `Permissions-Policy` | – | **the app** (`game/SecurityHeaders.js`) |
| Watchtower (label `com.centurylinklabs.watchtower.enable=true`) | runs it, host-wide | labels app + PostgreSQL |
| Site file | `config/sites/play.pikdame.caddy` | template: `docker/shared-caddy/play.pikdame.caddy` |

The app computes the CSP hash of `index.html`'s inline script at startup, so
the policy always matches the HTML in the same image; no proxy config has to be
redeployed for it. `common` overwrites `nosniff`, `Referrer-Policy` and HSTS
with its own values (HSTS without `includeSubDomains`); everything else from the
app passes through unchanged.

## Setup (once per host)

1. Shared stack per its README (`/opt/caddy`, `.env` with `ACME_EMAIL` and
   `CROWDSEC_API_KEY`).
2. The app network, owned by no stack:
   ```sh
   docker network create --internal caddy_play_pikdame
   ```
3. In `/opt/caddy/compose.yaml`: add `caddy_play_pikdame: {}` to the `caddy`
   service's `networks:` and `caddy_play_pikdame: { external: true }` to the
   top-level `networks:`.
4. Site file:
   ```sh
   cp /opt/pikdame/docker/shared-caddy/play.pikdame.caddy /opt/caddy/config/sites/
   chmod 0644 /opt/caddy/config/sites/play.pikdame.caddy
   ```
5. Start the Pik Dame stack first, then Caddy (or reload it):
   ```sh
   cd /opt/pikdame/docker && docker compose -f docker-compose.prod.yml up -d
   cd /opt/caddy && docker compose up -d caddy
   ```

The site file sets `stream_close_delay 5m`: a Caddy reload would otherwise
close every open WebSocket, i.e. every running game.

## Migrating from the bundled Caddy (before v2.58.0)

The old stack ran its own Caddy, CrowdSec, Watchtower and socket proxy on ports
80/443. Expect about a minute without the site while the ports change hands.

1. Steps 1–4 above (Caddy not started yet: the old one still holds 80/443).
2. Update the Pik Dame stack. `--remove-orphans` removes the old Caddy,
   CrowdSec, Watchtower and socket proxy and frees the ports:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/server-update.sh | bash
   ```
3. `cd /opt/caddy && docker compose up -d`, then wait for
   `certificate obtained successfully` in `docker compose logs -f caddy`.
4. Check: `curl -sI https://play.pikdame.online | grep -i content-security`
   and a game in the browser (WebSocket connects).
5. Remove from `.env`: `ACME_EMAIL`, `CROWDSEC_API_KEY`. Old volumes
   (`docker volume ls | grep -E 'caddy|crowdsec'`, prefixed with the old project
   name) can be deleted once the new certificate is in place.

Rolling back: the previous release's compose file still works, its
`pikdame-local-caddy` image stays in GHCR; stop the shared Caddy first (ports).

## Troubleshooting

- **502 from Caddy:** the app is not on `caddy_play_pikdame` or has no alias
  `pikdame`. `docker network inspect caddy_play_pikdame` must list both
  `caddy` and `pikdame`.
- **403 on a legitimate request:** AppSec false positive.
  `docker compose -f /opt/caddy/compose.yaml exec crowdsec cscli alerts list`
  shows the rule.
- **Every visitor shares one rate limit:** IPv6 relaying, see "Limits" in the
  caddy-crowdsec README. The app's own per-IP limits use the same address
  (`X-Forwarded-For`, `PIKDAME_TRUST_PROXY=1`).
