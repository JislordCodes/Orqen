output "api_url" {
  description = "Set this as VITE_API_URL on Vercel."
  value       = "https://${local.api_domain}"
}

output "preview_domain" {
  value = local.preview_domain
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "ecr_repositories" {
  description = "Image repositories (api, worker, sandbox)."
  value       = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_api_service" {
  value = aws_ecs_service.api.name
}

output "api_task_family" {
  value = aws_ecs_task_definition.api.family
}

output "worker_asg_name" {
  value = aws_autoscaling_group.worker.name
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "state_bucket" {
  description = "S3 bucket for snapshots (snapshots/) and chat sessions (sessions/)."
  value       = aws_s3_bucket.state.bucket
}

output "nebius_secret_arn" {
  description = "Put the LLM key here: aws secretsmanager put-secret-value --secret-id <arn> --secret-string ..."
  value       = aws_secretsmanager_secret.nebius_api_key.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis_auth.arn
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN GitHub Actions variable."
  value       = aws_iam_role.github_deploy.arn
}

output "ssm_worker_image_param" {
  value = aws_ssm_parameter.worker_image.name
}

output "ssm_sandbox_image_param" {
  value = aws_ssm_parameter.sandbox_image.name
}

output "log_groups" {
  value = { api = aws_cloudwatch_log_group.api.name, worker = aws_cloudwatch_log_group.worker.name }
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
