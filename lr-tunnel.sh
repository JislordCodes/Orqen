#!/usr/bin/env bash
# Usage: lr-tunnel.sh <local-port>  -> keeps a localhost.run tunnel up and writes its URL to /tmp/lr-<port>.url
# localhost.run streams Server-Sent Events live; Cloudflare quick tunnels buffer them until the stream ends.
PORT="$1"
while true; do
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -R "80:localhost:${PORT}" "nokey@localhost.run" 2>&1 | while IFS= read -r line; do
    u=$(printf '%s' "$line" | grep -o 'https://[a-z0-9]*\.lhr\.life' | head -1)
    [ -n "$u" ] && printf '%s\n' "$u" > "/tmp/lr-${PORT}.url"
  done
  sleep 3
done
