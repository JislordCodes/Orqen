resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-target-5xx"
  alarm_description   = "API returned 5xx responses"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 25
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${local.name}-api-unhealthy-targets"
  alarm_description   = "At least one API task fails /ready"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name          = "${local.name}-api-cpu-high"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.api.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "worker_hosts" {
  alarm_name          = "${local.name}-worker-hosts-missing"
  alarm_description   = "No worker host in service: runs queue up but never start"
  namespace           = "AWS/AutoScaling"
  metric_name         = "GroupInServiceInstances"
  dimensions          = { AutoScalingGroupName = aws_autoscaling_group.worker.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "worker_cpu" {
  alarm_name          = "${local.name}-worker-cpu-high"
  alarm_description   = "Worker hosts saturated: add hosts or lower MAX_CONCURRENT_RUNS"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { AutoScalingGroupName = aws_autoscaling_group.worker.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${local.name}-redis-memory"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.main.id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${local.name}-redis-engine-cpu"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.main.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
}

# Worker errors from the JSON logs ("level": "ERROR") as a metric + alarm.
resource "aws_cloudwatch_log_metric_filter" "worker_errors" {
  name           = "${local.name}-worker-errors"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.level = \"ERROR\" }"
  metric_transformation {
    name          = "WorkerErrors"
    namespace     = "Orqen/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.name}-worker-errors"
  namespace           = "Orqen/${var.environment}"
  metric_name         = "WorkerErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}
