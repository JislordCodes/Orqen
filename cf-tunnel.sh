#!/usr/bin/env bash
# Usage: cf-tunnel.sh <local-port> -> keeps a Cloudflare quick tunnel up; URL in /tmp/cf-<port>.url.
# A quick tunnel keeps one URL for as long as cloudflared runs (hours to days), unlike
# localhost.run, which hands out a new URL every time it reconnects. Cloudflare buffers
# streaming responses, so the frontend long-polls the events endpoint (poll=1) behind it.
PORT="$1"
exec 9>"/tmp/cf-${PORT}.lock"
flock -n 9 || exit 0
[ -x /tmp/cloudflared ] || { curl -sL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 && chmod +x /tmp/cloudflared; }
while true; do
  /tmp/cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
    u=$(printf '%s' "$line" | grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)
    [ -n "$u" ] && printf '%s\n' "$u" > "/tmp/cf-${PORT}.url"
  done
  sleep 5
done
