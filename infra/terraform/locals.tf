locals {
  name           = "${var.project}-${var.environment}"
  api_domain     = "${var.api_subdomain}.${var.domain_name}"
  preview_domain = "${var.preview_subdomain}.${var.domain_name}"
  azs            = slice(data.aws_availability_zones.available.names, 0, 2)
  account_id     = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition

  public_subnets  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnets = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  ssm_prefix = "/${var.project}/${var.environment}"
  # Docker publishes sandbox preview ports in the kernel's ephemeral range.
  ephemeral_from = 32768
  ephemeral_to   = 60999
}
