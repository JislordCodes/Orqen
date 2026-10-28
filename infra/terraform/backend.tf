# Remote state in S3 with DynamoDB locking. The values live in backend.hcl (not committed):
#   cp backend.hcl.example backend.hcl && terraform init -backend-config=backend.hcl
# Bootstrap the bucket + table once (docs/DEPLOYMENT.md, "AWS account bootstrap").
terraform {
  backend "s3" {}
}
