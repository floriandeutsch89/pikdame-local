# Custom Caddy build with the CrowdSec bouncer plugin.
# Standard Caddy images cannot load plugins at runtime - plugins are
# compiled in via xcaddy. This is the official, supported way.
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build \
    --with github.com/hslatman/caddy-crowdsec-bouncer/http

FROM caddy:2-alpine
# The licenses label reflects the shipped software: Caddy and the CrowdSec
# bouncer plugin are Apache-2.0 (our build recipe itself is MIT, see repo).
# The source label links the GHCR package to this repository.
LABEL org.opencontainers.image.title="Pik Dame Caddy" \
      org.opencontainers.image.description="Caddy 2 with the CrowdSec bouncer plugin compiled in (xcaddy) - the reverse proxy in front of play.pikdame.online" \
      org.opencontainers.image.source="https://github.com/floriandeutsch89/pikdame-local" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
