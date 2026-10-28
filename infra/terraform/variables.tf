variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "orqen"
}

variable "environment" {
  description = "Environment name (prod, staging...). Part of resource names."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
}

# ---------------------------------------------------------------- DNS
variable "domain_name" {
  description = "Base domain, e.g. example.com. The API is api.<domain>, previews are *.preview.<domain>."
  type        = string
}

variable "hosted_zone_id" {
  description = "ID of the existing Route 53 public hosted zone for domain_name."
  type        = string
}

variable "api_subdomain" {
  description = "Subdomain for the API."
  type        = string
  default     = "api"
}

variable "preview_subdomain" {
  description = "Subdomain whose wildcard serves app previews (<token>.preview.<domain>)."
  type        = string
  default     = "preview"
}

# ---------------------------------------------------------------- network
variable "vpc_cidr" {
  description = "VPC CIDR. Two public and two private /20 subnets are carved from it."
  type        = string
  default     = "10.40.0.0/16"
}

variable "single_nat_gateway" {
  description = "One NAT gateway for both AZs (cheaper) instead of one per AZ (more available)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- API (ECS Fargate)
variable "api_image_tag" {
  description = "Initial image tag for the API task definition. CI registers new revisions afterwards."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  description = "Fargate CPU units per API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) per API task."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "API tasks (spread over 2 AZs)."
  type        = number
  default     = 2
}

variable "api_max_count" {
  description = "Upper bound for API autoscaling."
  type        = number
  default     = 6
}

variable "api_uvicorn_workers" {
  description = "Uvicorn worker processes per API task."
  type        = number
  default     = 2
}

variable "cors_origins" {
  description = "Exact origins allowed to call the API, e.g. [\"https://orqen.vercel.app\", \"https://app.example.com\"]."
  type        = list(string)
}

variable "cors_origin_regex" {
  description = "Optional regex for extra origins (Vercel preview deployments). Empty = none."
  type        = string
  default     = ""
}

variable "auth_mode" {
  description = "dev (trust X-User-Id: never on a public endpoint) or jwt."
  type        = string
  default     = "jwt"
  validation {
    condition     = contains(["dev", "jwt"], var.auth_mode)
    error_message = "auth_mode must be dev or jwt."
  }
}

variable "jwt_jwks_url" {
  description = "JWKS URL of the identity provider (required for auth_mode=jwt)."
  type        = string
  default     = ""
}

variable "jwt_issuer" {
  description = "Expected iss claim."
  type        = string
  default     = ""
}

variable "jwt_audience" {
  description = "Expected aud claim."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- worker (EC2 ASG)
variable "worker_instance_type" {
  description = "Worker host type. Each sandbox may use up to sandbox_mem; m6i.xlarge (4 vCPU / 16 GiB) fits ~3 concurrent runs at 3g."
  type        = string
  default     = "m6i.xlarge"
}

variable "worker_volume_size_gb" {
  description = "Root gp3 volume for Docker images, sandbox volumes and local snapshots."
  type        = number
  default     = 200
}

variable "worker_min_size" {
  type    = number
  default = 1
}

variable "worker_max_size" {
  type    = number
  default = 3
}

variable "worker_desired_capacity" {
  description = "Worker hosts. Start with 1: a project's container and volume live on one host (S3 snapshots move projects between hosts, at the cost of reinstalling dependencies)."
  type        = number
  default     = 1
}

variable "worker_max_concurrent_runs" {
  description = "MAX_CONCURRENT_RUNS per worker host."
  type        = number
  default     = 3
}

variable "worker_image_tag" {
  type    = string
  default = "latest"
}

variable "sandbox_image_tag" {
  type    = string
  default = "latest"
}

variable "sandbox_mem" {
  type    = string
  default = "3g"
}

variable "sandbox_cpus" {
  type    = string
  default = "1.0"
}

variable "sandbox_network_cidr" {
  description = "Subnet of the Docker network sandboxes run on (firewalled off from the VPC and IMDS)."
  type        = string
  default     = "172.30.0.0/16"
}

# ---------------------------------------------------------------- LLM
variable "llm_base_url" {
  type    = string
  default = "https://api.studio.nebius.com/v1/"
}

variable "llm_model_id" {
  type    = string
  default = "zai-org/GLM-5.3"
}

variable "llm_planner_model_id" {
  type    = string
  default = ""
}

# ---------------------------------------------------------------- Redis
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_num_nodes" {
  description = "1 = single node; 2+ = primary + replicas with automatic failover (Multi-AZ)."
  type        = number
  default     = 1
}

# ---------------------------------------------------------------- storage / ops
variable "snapshot_noncurrent_days" {
  description = "Days to keep overwritten snapshot versions."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_email" {
  description = "Email subscribed to the alarm SNS topic (confirm the subscription mail). Empty = no subscription."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- CI (GitHub OIDC)
variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
  default     = "WaleX-projects/orqen"
}

variable "github_deploy_refs" {
  description = "Git refs (sub claim suffixes) allowed to deploy."
  type        = list(string)
  default     = ["ref:refs/heads/main", "environment:production"]
}

variable "create_github_oidc_provider" {
  description = "Create the token.actions.githubusercontent.com OIDC provider (false if the account already has one)."
  type        = bool
  default     = true
}
