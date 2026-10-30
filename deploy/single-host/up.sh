#!/usr/bin/env bash
# Runs ON the EC2 host (as root): pull the latest main, fetch the env from SSM, build, (re)start.
# Called by user-data on first boot and by the "Deploy single host" workflow (redeploy) via SSM.
set -euo pipefail
cd /opt/orqen
git fetch --depth 1 origin main
git reset --hard origin/main

if [ -f /etc/orqen/backend.env ]; then          # Lightsail: env delivered by user-data / SSH
  cp /etc/orqen/backend.env backend/.env.prod
else                                              # EC2: env lives in SSM Parameter Store
  REGION=$(cat /etc/orqen/region)
  aws ssm get-parameter --region "$REGION" --name /orqen/single/env --with-decryption \
    --query Parameter.Value --output text > backend/.env.prod
fi
chmod 600 backend/.env.prod

cp /etc/orqen/compose.env .env
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env

C="docker compose -f docker-compose.prod.yml -f deploy/single-host/compose.override.yml"
$C --profile build build sandbox-image
$C up -d --build --remove-orphans
docker image prune -f >/dev/null || true
echo "orqen up: https://$(grep ^API_DOMAIN= .env | cut -d= -f2)/health"
