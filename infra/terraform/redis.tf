resource "random_password" "redis" {
  length           = 48
  special          = true
  override_special = "!&#$^<>-" # characters ElastiCache accepts in AUTH tokens
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "Orqen job queue, run event streams and locks"
  engine                     = "redis"
  engine_version             = "7.1"
  parameter_group_name       = "default.redis7"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_num_nodes
  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = 3
  snapshot_window            = "02:00-03:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  apply_immediately          = false
}
