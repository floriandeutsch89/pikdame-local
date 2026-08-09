# Custom Caddy build with the CrowdSec bouncer plugin AND the site config.
# Standard Caddy images cannot load plugins at runtime - plugins are
# compiled in via xcaddy. This is the official, supported way.
#
# The Caddyfile is BAKED IN, not bind-mounted, and it lives next to this
# Dockerfile rather than one directory up. Two reasons:
#
#   1. The Caddyfile pins the inline head script of public/index.html by its
#      sha256 (CSP). That hash changes whenever the script changes - it belongs
#      to the same commit as the app image. A bind mount made the two
#      independently versioned: a host that pulled a new app image but kept an
#      old Caddyfile got a SILENTLY blocked head script (no crawler detection,
#      splash on every load, lobby flash). Baked in, they ship as one unit.
#   2. Inside this build context, the release workflow's rebuild gate - a
#      fingerprint over docker/caddy/** - covers the Caddyfile too. One
#      directory up it would not, and a CSP change would be silently RETAGGED
#      instead of rebuilt, which is exactly the failure mode of point 1.
#
# To try something out on the server without a rebuild, mount over it once:
#   volumes: ['./caddy/Caddyfile:/etc/caddy/Caddyfile:ro']
# then: docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build \
    --with github.com/hslatman/caddy-crowdsec-bouncer/http

FROM caddy:2-alpine
# The licenses label reflects the shipped software: Caddy and the CrowdSec
# bouncer plugin are Apache-2.0 (our build recipe itself is MIT, see repo).
# The source label links the GHCR package to this repository.
LABEL org.opencontainers.image.title="Pik Dame Caddy" \
      org.opencontainers.image.description="Caddy 2 with the CrowdSec bouncer plugin compiled in (xcaddy) and the play.pikdame.online site config baked in" \
      org.opencontainers.image.source="https://github.com/floriandeutsch89/pikdame-local" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
