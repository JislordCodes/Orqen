# Durable state: project snapshots (snapshots/, snapshots/archive/) and agent chat history (sessions/).
resource "aws_s3_bucket" "state" {
  bucket        = "${local.name}-state-${local.account_id}"
  force_destroy = var.environment != "prod"
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "snapshot-versions"
    status = "Enabled"
    filter {
      prefix = "snapshots/"
    }
    noncurrent_version_expiration {
      noncurrent_days = var.snapshot_noncurrent_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }

  rule {
    id     = "snapshot-archive-to-ia"
    status = "Enabled"
    filter {
      prefix = "snapshots/archive/"
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }

  rule {
    id     = "session-versions"
    status = "Enabled"
    filter {
      prefix = "sessions/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.state]
}
