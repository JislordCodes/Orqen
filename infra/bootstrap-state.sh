#!/usr/bin/env bash
# One-time: create the Terraform remote-state bucket (versioned, encrypted, private) and lock table.
# Usage: AWS_PROFILE=... ./infra/bootstrap-state.sh [region]   -> prints the backend.hcl to use
set -euo pipefail
REGION="${1:-eu-west-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="orqen-tfstate-${ACCOUNT}"
TABLE="orqen-tf-locks"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

if ! aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null
fi

cat <<HCL
# infra/terraform/backend.hcl
bucket         = "${BUCKET}"
key            = "orqen/prod/terraform.tfstate"
region         = "${REGION}"
dynamodb_table = "${TABLE}"
encrypt        = true
HCL
