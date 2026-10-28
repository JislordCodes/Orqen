# Worker hosts: EC2 (not Fargate) because the worker drives a real Docker daemon, one sandbox
# container per project. Amazon Linux 2023 + Docker via user-data; the worker itself is a container.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  worker_asg_name       = "${local.name}-worker"
  worker_lifecycle_hook = "drain"
  worker_shutdown_grace = 120
}

resource "aws_launch_template" "worker" {
  name_prefix   = "${local.name}-worker-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = var.worker_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.worker.arn
  }

  vpc_security_group_ids = [aws_security_group.worker.id]

  # IMDSv2 only, hop limit 1: containers on Docker bridge networks (the sandboxes) cannot obtain
  # metadata tokens; the worker runs with --network host and can.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.worker_volume_size_gb
      volume_type           = "gp3"
      iops                  = 3000
      throughput            = 250
      encrypted             = true
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  user_data = base64encode(templatefile("${path.module}/templates/worker-user-data.sh.tftpl", {
    region               = var.region
    ssm_prefix           = local.ssm_prefix
    sandbox_network      = "orqen-sbx"
    sandbox_cidr         = var.sandbox_network_cidr
    vpc_cidr             = var.vpc_cidr
    redis_url            = local.redis_url
    redis_secret_arn     = aws_secretsmanager_secret.redis_auth.arn
    nebius_secret_arn    = aws_secretsmanager_secret.nebius_api_key.arn
    llm_base_url         = var.llm_base_url
    llm_model_id         = var.llm_model_id
    llm_planner_model_id = var.llm_planner_model_id
    sandbox_mem          = var.sandbox_mem
    sandbox_cpus         = var.sandbox_cpus
    max_concurrent_runs  = var.worker_max_concurrent_runs
    shutdown_grace       = local.worker_shutdown_grace
    state_bucket         = aws_s3_bucket.state.bucket
    log_group            = aws_cloudwatch_log_group.worker.name
    asg_name             = local.worker_asg_name
    lifecycle_hook       = local.worker_lifecycle_hook
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-worker", Role = "orqen-worker" }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${local.name}-worker" }
  }
}

resource "aws_autoscaling_group" "worker" {
  name                      = local.worker_asg_name
  min_size                  = var.worker_min_size
  max_size                  = var.worker_max_size
  desired_capacity          = var.worker_desired_capacity
  vpc_zone_identifier       = aws_subnet.private[*].id
  health_check_type         = "EC2"
  health_check_grace_period = 300
  default_instance_warmup   = 300
  enabled_metrics           = ["GroupInServiceInstances", "GroupDesiredCapacity", "GroupTerminatingInstances"]

  launch_template {
    id      = aws_launch_template.worker.id
    version = "$Latest"
  }

  # Hold terminating instances while the worker drains (lifecycle-watch.sh completes the action).
  initial_lifecycle_hook {
    name                 = local.worker_lifecycle_hook
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    default_result       = "CONTINUE"
    heartbeat_timeout    = 600
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 200
      instance_warmup        = 300
    }
  }

  tag {
    key                 = "Role"
    value               = "orqen-worker"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}
