#!/usr/bin/env bash
# Usage: lr-tunnel.sh <local-port>  -> keeps a localhost.run tunnel up and writes its URL to /tmp/lr-<port>.url
# localhost.run streams Server-Sent Events live; Cloudflare quick tunnels buffer them until the stream ends.
# localhost.run sometimes drops a tunnel on its side while ssh stays connected (the URL then answers
# "no tunnel"). A checker notices that and kills ssh so the loop reconnects.
PORT="$1"
while true; do
  ( ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -R "80:localhost:${PORT}" "nokey@localhost.run" 2>&1 | while IFS= read -r line; do
    u=$(printf '%s' "$line" | grep -o 'https://[a-z0-9]*\.lhr\.life' | head -1)
    [ -n "$u" ] && printf '%s\n' "$u" > "/tmp/lr-${PORT}.url"
  done ) &
  SUB=$!
  sleep 20
  while kill -0 "$SUB" 2>/dev/null; do
    u=$(cat "/tmp/lr-${PORT}.url" 2>/dev/null)
    if [ -n "$u" ] && curl -s -m 15 "$u" | head -c 200 | grep -q '^no tunnel'; then
      pkill -P "$SUB" 2>/dev/null; kill "$SUB" 2>/dev/null
      break
    fi
    sleep 45
  done
  wait "$SUB" 2>/dev/null
  sleep 3
done
