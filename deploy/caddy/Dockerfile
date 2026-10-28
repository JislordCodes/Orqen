# Caddy with the Route 53 DNS module, so it can obtain ONE wildcard certificate for
# *.<PREVIEW_DOMAIN> via the DNS-01 challenge (preview links are random subdomains; issuing a
# certificate per link would hit Let's Encrypt rate limits).
# Swap the module for your DNS provider if the zone is not in Route 53 (e.g. caddy-dns/cloudflare).
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/route53

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
