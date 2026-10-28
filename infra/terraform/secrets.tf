# The LLM key is set out of band (never in Terraform state):
#   aws secretsmanager put-secret-value --secret-id <output nebius_secret_arn> --secret-string 'sk-...'
resource "aws_secretsmanager_secret" "nebius_api_key" {
  name                    = "${local.name}/nebius-api-key"
  description             = "NEBIUS_API_KEY for the worker (OpenAI-compatible LLM endpoint)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "${local.name}/redis-auth-token"
  description             = "ElastiCache AUTH token (REDIS_PASSWORD)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis.result
}

# Image pointers the worker hosts read at boot and on every deploy (CI updates them).
resource "aws_ssm_parameter" "worker_image" {
  name  = "${local.ssm_prefix}/worker_image"
  type  = "String"
  value = "${aws_ecr_repository.repo["worker"].repository_url}:${var.worker_image_tag}"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "sandbox_image" {
  name  = "${local.ssm_prefix}/sandbox_image"
  type  = "String"
  value = "${aws_ecr_repository.repo["sandbox"].repository_url}:${var.sandbox_image_tag}"
  lifecycle {
    ignore_changes = [value]
  }
}
