data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- API: execution role (pull + logs + secrets)
resource "aws_iam_role" "api_execution" {
  name               = "${local.name}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "api_execution_managed" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "api_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.redis_auth.arn]
  }
}

resource "aws_iam_role_policy" "api_execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.api_execution.id
  policy = data.aws_iam_policy_document.api_execution_secrets.json
}

# ---------------------------------------------------------------- API: task role (read snapshot metadata only)
resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "ListSnapshots"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["snapshots/*"]
    }
  }
  statement {
    sid       = "ReadSnapshotMetadata"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/snapshots/*"]
  }
  statement {
    sid = "EcsExec"
    actions = [
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# ---------------------------------------------------------------- worker hosts (EC2 instance profile)
resource "aws_iam_role" "worker" {
  name = "${local.name}-worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.repo["worker"].arn, aws_ecr_repository.repo["sandbox"].arn]
  }
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    sid       = "StateBucketObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/snapshots/*", "${aws_s3_bucket.state.arn}/sessions/*"]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.nebius_api_key.arn, aws_secretsmanager_secret.redis_auth.arn]
  }
  statement {
    sid       = "ImagePointers"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }
  statement {
    sid       = "DrainOnTermination"
    actions   = ["autoscaling:CompleteLifecycleAction", "autoscaling:RecordLifecycleActionHeartbeat"]
    resources = ["arn:${local.partition}:autoscaling:${var.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.name}-worker"]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_instance_profile" "worker" {
  name = "${local.name}-worker"
  role = aws_iam_role.worker.name
}
