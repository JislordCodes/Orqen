#!/usr/bin/env bash
# Provision / redeploy / destroy the single-host Orqen backend on Amazon LIGHTSAIL.
# Used when the AWS account can't use EC2 (e.g. hackathon / org accounts whose SCP allows Lightsail).
#   ACTION=deploy    static IP + Ubuntu instance (8 GB, else 4 GB) + ports 80/443, boots via user-data
#   ACTION=redeploy  push env over SSH and run up.sh (git pull + rebuild)
#   ACTION=destroy   delete the instance and release the static IP
# Env: AWS creds, AWS_REGION (Lightsail region), NEBIUS_API_KEY, optional CORS_ORIGINS, MODEL_ID, ...
set -euo pipefail
ACTION=${ACTION:-deploy}
R=${AWS_REGION:-us-east-1}
N=orqen-single
IPN=orqen-single-ip
REPO_URL=${REPO_URL:-https://github.com/JislordCodes/Orqen.git}
ACME_EMAIL=${ACME_EMAIL:-jislorda@gmail.com}
export AWS_DEFAULT_REGION=$R AWS_PAGER=""
HERE=$(cd "$(dirname "$0")" && pwd)
summary() { echo "$*"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }
L="aws lightsail"

backend_env() {
  : "${NEBIUS_API_KEY:?set NEBIUS_API_KEY}"
  local dashed=$1
  cat <<EOF
APP_ENV=production
NEBIUS_API_KEY=$NEBIUS_API_KEY
BASE_URL=${BASE_URL:-https://api.studio.nebius.com/v1/}
MODEL_ID=${MODEL_ID:-zai-org/GLM-5.3}
CORS_ORIGINS=${CORS_ORIGINS:-https://orqen-amber.vercel.app}
CORS_ORIGIN_REGEX=${CORS_ORIGIN_REGEX:-^https://orqen-[a-z0-9-]+-auroramd\\.vercel\\.app\$}
AUTH_MODE=${AUTH_MODE:-dev}
MAX_CONCURRENT_RUNS=${MAX_CONCURRENT_RUNS:-1}
MAX_TOOL_CALLS=${MAX_TOOL_CALLS:-200}
SANDBOX_MEM=${SANDBOX_MEM:-3g}
SANDBOX_CPUS=${SANDBOX_CPUS:-1.5}
PREVIEW_DOMAIN=preview.$dashed.sslip.io
EOF
}

ssh_key() {
  local k; k=$(mktemp)
  $L download-default-key-pair --query privateKeyBase64 --output text > "$k"
  chmod 600 "$k"; echo "$k"
}

exists() { $L get-instance --instance-name $N >/dev/null 2>&1; }

if [ "$ACTION" = destroy ]; then
  exists && $L delete-instance --instance-name $N --force-delete-add-ons >/dev/null || true
  $L release-static-ip --static-ip-name $IPN >/dev/null 2>&1 || true
  summary "Destroyed $N."
  exit 0
fi

# ---- static IP when the account allows it (stable address); else the instance's own public IP
STATIC=1
if ! $L get-static-ip --static-ip-name $IPN >/dev/null 2>&1; then
  $L allocate-static-ip --static-ip-name $IPN >/dev/null 2>&1 || { STATIC=0; echo "static IP not allowed; using the instance's public IP"; }
fi
if [ $STATIC = 1 ]; then
  IP=$($L get-static-ip --static-ip-name $IPN --query staticIp.ipAddress --output text)
  DASHED=${IP//./-}; API_DOMAIN=api.$DASHED.sslip.io; PREVIEW_DOMAIN=preview.$DASHED.sslip.io
elif exists; then
  IP=$($L get-instance --instance-name $N --query instance.publicIpAddress --output text)
  DASHED=${IP//./-}; API_DOMAIN=api.$DASHED.sslip.io; PREVIEW_DOMAIN=preview.$DASHED.sslip.io
else
  DASHED=auto; API_DOMAIN=AUTO; PREVIEW_DOMAIN=AUTO
fi
ENVF=$(mktemp); backend_env "$DASHED" > "$ENVF"

if [ "$ACTION" = redeploy ]; then
  exists || { echo "no instance yet; run deploy first"; exit 0; }
  HOSTIP=$($L get-instance --instance-name $N --query instance.publicIpAddress --output text)
  K=$(ssh_key)
  S="ssh -i $K -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$HOSTIP"
  $S "sudo install -d -m 700 /etc/orqen && sudo tee /etc/orqen/backend.env >/dev/null && sudo chmod 600 /etc/orqen/backend.env" < "$ENVF"
  $S "sudo bash /opt/orqen/deploy/single-host/up.sh"
  summary "Redeployed. API: https://$API_DOMAIN"
  exit 0
fi

if ! exists; then
  BP=$($L get-blueprints --query "blueprints[?isActive && starts_with(blueprintId,'ubuntu_24')].blueprintId | [0]" --output text)
  [ "$BP" != None ] || BP=$($L get-blueprints --query "blueprints[?isActive && starts_with(blueprintId,'ubuntu_22')].blueprintId | [0]" --output text)
  AZ=$($L get-regions --include-availability-zones --query "regions[?name=='$R'].availabilityZones[0].zoneName | [0]" --output text)
  UD=$(mktemp)
  sed -e "s|__REGION__|$R|" -e "s|__API_DOMAIN__|$API_DOMAIN|" -e "s|__PREVIEW_DOMAIN__|$PREVIEW_DOMAIN|" \
      -e "s|__ACME_EMAIL__|$ACME_EMAIL|" -e "s|__REPO__|$REPO_URL|" "$HERE/user-data.sh" > "$UD"
  # Lightsail has no instance roles/SSM: the env goes in with the first-boot script.
  python3 - "$UD" "$ENVF" <<'PY'
import sys
ud, env = sys.argv[1], open(sys.argv[2]).read()
s = open(ud).read()
block = "install -d -m 700 /etc/orqen\ncat > /etc/orqen/backend.env <<'ORQENENV'\n" + env + "ORQENENV\nchmod 600 /etc/orqen/backend.env\n"
s = s.replace("mkdir -p /etc/orqen\n", block, 1)
open(ud, "w").write(s)
PY
  made=""
  for RAM in 8 4; do
    for B in $($L get-bundles --query "bundles[?isActive && ramSizeInGb==\`$RAM.0\` && contains(supportedPlatforms,'LINUX_UNIX')] | sort_by(@,&price)[].bundleId" --output text); do
      echo "trying bundle $B ($RAM GB) with $BP in $AZ"
      if $L create-instances --instance-names $N --availability-zone "$AZ" --blueprint-id "$BP" --bundle-id "$B" \
          --user-data "file://$UD" --tags key=project,value=orqen >/dev/null; then made=$B; break 2; fi
    done
  done
  [ -n "$made" ] || { echo "could not create a Lightsail instance"; exit 1; }
  echo "created $N on $made"
fi

for _ in $(seq 1 40); do
  st=$($L get-instance --instance-name $N --query instance.state.name --output text)
  [ "$st" = running ] && break; sleep 10
done
if [ $STATIC = 1 ]; then $L attach-static-ip --static-ip-name $IPN --instance-name $N >/dev/null 2>&1 || true; fi
sleep 5
IP=$($L get-instance --instance-name $N --query instance.publicIpAddress --output text)
DASHED=${IP//./-}; API_DOMAIN=api.$DASHED.sslip.io
$L put-instance-public-ports --instance-name $N --port-infos \
  fromPort=22,toPort=22,protocol=tcp fromPort=80,toPort=80,protocol=tcp \
  fromPort=443,toPort=443,protocol=tcp fromPort=443,toPort=443,protocol=udp >/dev/null
BUNDLE=$($L get-instance --instance-name $N --query instance.bundleId --output text)

summary "## Orqen backend (Lightsail)"
summary "- Instance: $N ($BUNDLE, $R), IP $IP (static: $STATIC)"
summary "- API: https://$API_DOMAIN (health: https://$API_DOMAIN/health)"
summary "- Set VITE_API_URL=https://$API_DOMAIN in Vercel and redeploy the frontend."
summary "- First boot installs Docker and builds the images: allow ~15-20 minutes."
echo "API_URL=https://$API_DOMAIN" >> "${GITHUB_OUTPUT:-/dev/null}"
