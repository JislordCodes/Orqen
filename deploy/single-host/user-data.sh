#!/bin/bash
# EC2 first-boot script (Ubuntu 24.04). Placeholders are filled in by provision.sh.
set -euxo pipefail
exec > >(tee -a /var/log/orqen-setup.log) 2>&1

mkdir -p /etc/orqen
echo "__REGION__" > /etc/orqen/region
cat > /etc/orqen/compose.env <<EOF
API_DOMAIN=__API_DOMAIN__
PREVIEW_DOMAIN=__PREVIEW_DOMAIN__
ACME_EMAIL=__ACME_EMAIL__
REDIS_PASSWORD=$(openssl rand -hex 24)
SANDBOX_IMAGE=orqen-sandbox:latest
UVICORN_WORKERS=2
EOF
chmod 600 /etc/orqen/compose.env

# 4 GB swap: builds and sandboxes share 8 GB of RAM.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git unzip jq openssl
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
if ! command -v aws >/dev/null; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip
  unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install
fi

if [ ! -d /opt/orqen/.git ]; then
  git clone --depth 1 --branch main __REPO__ /opt/orqen
fi
bash /opt/orqen/deploy/single-host/up.sh
echo ORQEN_SETUP_DONE
