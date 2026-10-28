locals {
  ecr_repos = ["api", "worker", "sandbox"]
}

resource "aws_ecr_repository" "repo" {
  for_each             = toset(local.ecr_repos)
  name                 = "${var.project}/${each.key}"
  image_tag_mutability = "MUTABLE" # "latest" is moved by CI; deploys pin the git-sha tag
  force_delete         = var.environment != "prod"

  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 30 images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      }
    ]
  })
}
