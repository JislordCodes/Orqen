#!/usr/bin/env bash
# Provision / redeploy / destroy the single-host Orqen backend on EC2 (AWS free-plan friendly).
#   ACTION=deploy    create (or reuse) SG, IAM role, Elastic IP, SSM env and the instance
#   ACTION=redeploy  push the env to SSM and run up.sh on the host via SSM (git pull + rebuild)
#   ACTION=destroy   terminate the instance, release the EIP, delete SG/role/parameter
# Env: AWS creds, AWS_REGION, NEBIUS_API_KEY, optional CORS_ORIGINS, CORS_ORIGIN_REGEX, MODEL_ID,
#      INSTANCE_TYPE (default m7i-flex.large), VOLUME_GB (default 60), ACME_EMAIL, REPO_URL.
set -euo pipefail
ACTION=${ACTION:-deploy}
R=${AWS_REGION:?set AWS_REGION}
N=orqen-single
TYPE=${INSTANCE_TYPE:-m7i-flex.large}
VOL=${VOLUME_GB:-60}
REPO_URL=${REPO_URL:-https://github.com/JislordCodes/Orqen.git}
ACME_EMAIL=${ACME_EMAIL:-jislorda@gmail.com}
export AWS_DEFAULT_REGION=$R AWS_PAGER=""
HERE=$(cd "$(dirname "$0")" && pwd)
summary() { echo "$*"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT region $R action $ACTION"

instance_id() {
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$N" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}'
}
eip_alloc() {
  aws ec2 describe-addresses --filters "Name=tag:Name,Values=$N" --query 'Addresses[0].AllocationId' --output text
}

put_env() {
  : "${NEBIUS_API_KEY:?set NEBIUS_API_KEY}"
  local ip=$1 dashed=${1//./-}
  local env
  env=$(cat <<EOF
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
)
  aws ssm put-parameter --name /orqen/single/env --type SecureString --overwrite --value "$env" >/dev/null
  echo "env stored in SSM /orqen/single/env"
}

if [ "$ACTION" = probe ]; then
  # Which regions / calls does this account allow? (organizations SCPs often restrict both)
  aws iam get-user --query User.Arn --output text 2>&1 | tail -1 || true
  for reg in us-east-1 us-east-2 us-west-2 eu-west-1 eu-central-1 eu-west-2 af-south-1; do
    for c in "ec2 describe-instances" "ec2 describe-addresses" "ec2 describe-vpcs" "ssm describe-parameters" "ec2 describe-instance-type-offerings --filters Name=instance-type,Values=m7i-flex.large,t3.small,t3.medium,t3.large --query InstanceTypeOfferings[].InstanceType"; do
      out=$(aws --region "$reg" $c --output text 2>&1 | tr '\n' ' ' | cut -c1-160) && echo "OK   $reg $c :: $out" || echo "DENY $reg $c :: $out"
    done
    for t in m7i-flex.large t3.large t3.medium t3.small; do
      out=$(aws --region "$reg" ec2 run-instances --dry-run --instance-type $t --image-id "$(aws --region $reg ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text 2>/dev/null)" 2>&1 | cut -c1-160)
      echo "RUN  $reg $t :: $out"
    done
  done
  exit 0
fi

if [ "$ACTION" = destroy ]; then
  id=$(instance_id); if [ -n "$id" ]; then aws ec2 terminate-instances --instance-ids "$id" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$id"; fi
  a=$(eip_alloc); [ "$a" != None ] && aws ec2 release-address --allocation-id "$a" || true
  sg=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$N" --query 'SecurityGroups[0].GroupId' --output text)
  [ "$sg" != None ] && aws ec2 delete-security-group --group-id "$sg" || true
  aws iam remove-role-from-instance-profile --instance-profile-name $N --role-name $N 2>/dev/null || true
  aws iam delete-instance-profile --instance-profile-name $N 2>/dev/null || true
  aws iam detach-role-policy --role-name $N --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
  aws iam delete-role-policy --role-name $N --policy-name read-env 2>/dev/null || true
  aws iam delete-role --role-name $N 2>/dev/null || true
  aws ssm delete-parameter --name /orqen/single/env 2>/dev/null || true
  summary "Destroyed $N."
  exit 0
fi

# ---- Elastic IP (stable address -> stable sslip.io hostname)
ALLOC=$(eip_alloc)
if [ "$ALLOC" = None ] || [ -z "$ALLOC" ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$N}]" --query AllocationId --output text)
fi
IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
DASHED=${IP//./-}
API_DOMAIN=api.$DASHED.sslip.io
PREVIEW_DOMAIN=preview.$DASHED.sslip.io
put_env "$IP"

if [ "$ACTION" = redeploy ]; then
  id=$(instance_id); [ -n "$id" ] || { echo "no instance; run deploy first"; exit 1; }
  cmd=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --parameters 'commands=["bash /opt/orqen/deploy/single-host/up.sh"],executionTimeout=["3600"]' \
    --query Command.CommandId --output text)
  echo "SSM command $cmd"
  for _ in $(seq 1 120); do
    st=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
    case $st in Success) break;; Failed|Cancelled|TimedOut) aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query StandardErrorContent --output text; exit 1;; esac
    sleep 15
  done
  summary "Redeployed. API: https://$API_DOMAIN"
  exit 0
fi

# ---- network: default VPC + security group (80/443 only; admin goes through SSM, no SSH)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != None ] || { echo "No default VPC in $R. Create one: aws ec2 create-default-vpc"; exit 1; }
SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$N" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name $N --description "Orqen single host: HTTP/HTTPS" --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=udp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi

# ---- IAM: instance role for SSM management + reading its env parameter
if ! aws iam get-role --role-name $N >/dev/null 2>&1; then
  aws iam create-role --role-name $N --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $N --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name $N --policy-name read-env --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:$R:$ACCOUNT:parameter/orqen/*\"}]}"
if ! aws iam get-instance-profile --instance-profile-name $N >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name $N >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $N --role-name $N
  sleep 15   # instance profiles take a moment to become usable
fi

# ---- instance
ID=$(instance_id)
if [ -z "$ID" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  UD=$(mktemp)
  sed -e "s|__REGION__|$R|" -e "s|__API_DOMAIN__|$API_DOMAIN|" -e "s|__PREVIEW_DOMAIN__|$PREVIEW_DOMAIN|" \
      -e "s|__ACME_EMAIL__|$ACME_EMAIL|" -e "s|__REPO__|$REPO_URL|" "$HERE/user-data.sh" > "$UD"
  for attempt in 1 2 3 4; do
    if ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" \
        --security-group-ids "$SG" --iam-instance-profile Name=$N \
        --user-data "file://$UD" \
        --metadata-options HttpTokens=required,HttpEndpoint=enabled \
        --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOL,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$N},{Key=project,Value=orqen}]" \
        --query 'Instances[0].InstanceId' --output text); then break; fi
    echo "run-instances failed (attempt $attempt), retrying"; sleep 15
  done
  [ -n "$ID" ] || exit 1
  echo "launched $ID ($TYPE)"
fi
aws ec2 wait instance-running --instance-ids "$ID"
aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" --allow-reassociation >/dev/null

summary "## Orqen backend"
summary "- Instance: $ID ($TYPE, $R)"
summary "- Public IP: $IP"
summary "- API: https://$API_DOMAIN (health: https://$API_DOMAIN/health)"
summary "- Set VITE_API_URL=https://$API_DOMAIN in Vercel and redeploy the frontend."
summary "- First boot installs Docker and builds the images: allow ~15 minutes."
echo "API_URL=https://$API_DOMAIN" >> "${GITHUB_OUTPUT:-/dev/null}"
