# GitHub Actions deploys with short-lived credentials (OIDC), no long-lived AWS keys in GitHub.
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "github_deploy" {
  name = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = [for r in var.github_deploy_refs : "repo:${var.github_repo}:${r}"] }
      }
    }]
  })
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
      "ecr:DescribeImages",
    ]
    resources = [for r in aws_ecr_repository.repo : r.arn]
  }
  statement {
    sid       = "EcsDeploy"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"] # these two actions do not support resource-level permissions
  }
  statement {
    sid       = "EcsService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.api.id]
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.api_execution.arn, aws_iam_role.api_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "ImagePointers"
    actions   = ["ssm:PutParameter", "ssm:GetParameter"]
    resources = [aws_ssm_parameter.worker_image.arn, aws_ssm_parameter.sandbox_image.arn]
  }
  statement {
    sid       = "RunDeployOnWorkers"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${local.partition}:ssm:${var.region}::document/AWS-RunShellScript"]
  }
  statement {
    sid       = "RunDeployOnWorkerInstances"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Role"
      values   = ["orqen-worker"]
    }
  }
  statement {
    sid       = "WatchCommands"
    actions   = ["ssm:ListCommandInvocations", "ssm:GetCommandInvocation", "ssm:ListCommands"]
    resources = ["*"]
  }
  statement {
    sid       = "InstanceRefresh"
    actions   = ["autoscaling:StartInstanceRefresh", "autoscaling:DescribeInstanceRefreshes"]
    resources = ["*"]
  }
  statement {
    sid       = "DescribeAsg"
    actions   = ["autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
