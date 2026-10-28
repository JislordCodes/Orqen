# API on ECS Fargate: stateless (Redis + S3), needs no Docker daemon since preview targets are
# looked up in Redis, so it scales and deploys independently of the worker hosts.
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  redis_url = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"

  api_environment = [
    { name = "APP_ENV", value = "production" },
    { name = "LOG_FORMAT", value = "json" },
    { name = "REDIS_URL", value = local.redis_url },
    { name = "CORS_ORIGINS", value = join(",", var.cors_origins) },
    { name = "CORS_ORIGIN_REGEX", value = var.cors_origin_regex },
    { name = "AUTH_MODE", value = var.auth_mode },
    { name = "JWT_JWKS_URL", value = var.jwt_jwks_url },
    { name = "JWT_ISSUER", value = var.jwt_issuer },
    { name = "JWT_AUDIENCE", value = var.jwt_audience },
    { name = "PREVIEW_DOMAIN", value = local.preview_domain },
    { name = "PREVIEW_SCHEME", value = "https" },
    { name = "SNAPSHOT_DIR", value = "" },
    { name = "SNAPSHOT_S3_BUCKET", value = aws_s3_bucket.state.bucket },
    { name = "SNAPSHOT_S3_PREFIX", value = "snapshots/" },
    { name = "AWS_REGION", value = var.region },
    { name = "UVICORN_WORKERS", value = tostring(var.api_uvicorn_workers) },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = "${aws_ecr_repository.repo["api"].repository_url}:${var.api_image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    environment  = local.api_environment
    secrets = [
      { name = "REDIS_PASSWORD", valueFrom = aws_secretsmanager_secret.redis_auth.arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8000/live || exit 1"]
      interval    = 15
      timeout     = 3
      retries     = 3
      startPeriod = 15
    }
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
  }])

  volume {
    name = "tmp"
  }
}

resource "aws_ecs_service" "api" {
  name                              = "${local.name}-api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30
  enable_execute_command            = true

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # CI registers new task definition revisions (deploy-backend.yml); autoscaling owns the count.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.api]
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
