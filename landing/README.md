# Landing page for pikdame.online

`index.html` is the start page of pikdame.online: visitors pick the card game
(`play.pikdame.online`) or the points tracker (`punkte.pikdame.online`, repo
`floriandeutsch89/pikdame`). One static file: no build, no script, no external
resources.

## Hosting (shared Caddy stack)

Served by the host's caddy-crowdsec stack ([docs/admin/shared-caddy.md](../docs/admin/shared-caddy.md)),
no container of its own:

```sh
cd /opt/docker/caddy          # the shared stack
mkdir -p config/www/pikdame.online
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/landing/index.html \
  -o config/www/pikdame.online/index.html
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/landing/pikdame.online.caddy \
  -o config/sites/pikdame.online.caddy
chmod 0644 config/www/pikdame.online/index.html config/sites/pikdame.online.caddy
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

`config/` is mounted read-only as `/etc/caddy`, so the page lives at
`/etc/caddy/www/pikdame.online`. Updating the page is the first `curl` again;
no reload needed.

## Order when moving the tracker

`pikdame.online.caddy` redirects every path except `/` to
`punkte.pikdame.online` (308, so old bookmarks, mail links and `/api/*` calls
keep working). Switch it on only **after** the tracker answers on
`punkte.pikdame.online`; until then the old tracker site file stays in place.
