resource "aws_cloudwatch_log_group" "api" {
  name              = "/${var.project}/${var.environment}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${var.project}/${var.environment}/worker"
  retention_in_days = var.log_retention_days
}
