#!/usr/bin/env bash
# Bring the whole Orqen stack back after a Hark sandbox reset. Idempotent.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! command -v redis-server >/dev/null || ! command -v dockerd >/dev/null; then
  sudo -n apt-get update -qq >/dev/null 2>&1
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server docker.io >/tmp/apt.log 2>&1
fi
command -v ssh >/dev/null || sudo -n apt-get install -y -qq openssh-client >/dev/null 2>&1
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null
if ! docker info >/dev/null 2>&1; then
  (sudo -n dockerd --iptables=false --ip6tables=false --bridge=none >/tmp/dockerd.log 2>&1 &)
  for i in $(seq 20); do [ -S /var/run/docker.sock ] && break; sleep 1; done
  sudo -n chmod 666 /var/run/docker.sock 2>/dev/null; sleep 2
fi
docker image inspect appbuilder-sandbox:latest >/dev/null 2>&1 || docker build -q --network host -t appbuilder-sandbox:latest "$ROOT/backend/sandbox_image" >/tmp/build.log 2>&1
cd "$ROOT/backend"
curl -s -m2 localhost:8000/health >/dev/null || (SANDBOX_NETWORK=host PREVIEW_URL_FILE=/tmp/lr-3000.url setsid nohup .venv/bin/uvicorn app.api:app --port 8000 >/tmp/api.log 2>&1 &)
# No worker means any run lock left in Redis (restored from its dump after a reset) is stale: it would
# make POST /runs answer 409 for up to an hour. Close those runs with an error event and free the lock.
if ! ps aux | grep -q "[a]pp.worker"; then
  for k in $(redis-cli --scan --pattern 'lock:*'); do
    rid=$(redis-cli get "$k")
    [ -n "$rid" ] && redis-cli xadd "run:$rid" '*' type error data '{"message": "The server restarted and this run was cut off. Send the prompt again."}' >/dev/null
    redis-cli del "$k" >/dev/null
  done
fi
ps aux | grep -q "[a]pp.worker" || (MAX_TOOL_CALLS=${MAX_TOOL_CALLS:-200} SNAPSHOT_DIR=${SNAPSHOT_DIR:-$ROOT/snapshots} SANDBOX_NETWORK=host BASE_URL=https://api.studio.nebius.com/v1/ MODEL_ID=${MODEL_ID:-moonshotai/Kimi-K2.7-Code} setsid nohup .venv/bin/python -m app.worker >/tmp/worker.log 2>&1 &)
cd "$ROOT/frontend"
curl -s -m2 -o /dev/null localhost:4173/ || (setsid nohup npx vite preview --host 0.0.0.0 --port 4173 >/tmp/vite.log 2>&1 &)
# localhost.run tunnels (they stream SSE live; Cloudflare quick tunnels buffer it). App on 4173, preview on 3000.
for port in 4173 3000; do
  ps -eo args | grep -q "^bash .*lr-tunnel.sh $port" || (setsid nohup bash "$ROOT/lr-tunnel.sh" $port >/dev/null 2>&1 &)
done
# The app also gets a Cloudflare quick tunnel: its URL lasts as long as cloudflared runs.
ps -eo args | grep -q "^bash .*cf-tunnel.sh 4173" || (setsid nohup bash "$ROOT/cf-tunnel.sh" 4173 >/dev/null 2>&1 &)
for i in $(seq 30); do [ -s /tmp/cf-4173.url ] && break; sleep 1; done
for i in $(seq 30); do U=$(cat /tmp/lr-4173.url 2>/dev/null); [ -n "$U" ] && [ -s /tmp/lr-3000.url ] && break; sleep 1; done
sleep 6; rm -f "$ROOT"/frontend/vite.config.ts.timestamp-*
echo "api: $(curl -s -m5 localhost:8000/health)  worker: $(ps aux | grep -c '[a]pp.worker')  web: $(curl -s -m5 -o /dev/null -w '%{http_code}' localhost:4173/)"
echo "url: $(cat /tmp/cf-4173.url 2>/dev/null)  (backup: $U)"
echo "preview: $(cat /tmp/lr-3000.url 2>/dev/null)"
