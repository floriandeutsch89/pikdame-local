# Custom Caddy build with the CrowdSec bouncer plugin.
# Standard Caddy images cannot load plugins at runtime - plugins are
# compiled in via xcaddy. This is the official, supported way.
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build \
    --with github.com/hslatman/caddy-crowdsec-bouncer/http

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
