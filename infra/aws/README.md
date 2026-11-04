# AWS deployment (ECS Fargate)

| Local (docker compose) | AWS |
|---|---|
| `api` container | ECS Fargate service `procurement-api` behind an **ALB** (target group on port 4000, health check `/health`) |
| `worker` container | ECS Fargate service `procurement-worker` (no load balancer; scale on Kafka consumer lag) |
| `web` (nginx) | S3 + CloudFront (static build of `apps/web`), `/api/*` behaviour → ALB |
| `kafka` | Amazon MSK (or Confluent Cloud) |
| `redis:8` | Redis Cloud / self-managed Redis 8 with the Query Engine (ElastiCache Valkey has no FT.* vector search) |
| `mongo` | MongoDB Atlas with a **Vector Search index** (`MONGO_VECTOR_SEARCH=atlas`) |
| LocalStack S3 | Amazon S3 (task role grants `s3:PutObject`/`GetObject` on the bucket; no keys in env) |
| `.env` | AWS Secrets Manager → injected via `secrets` in the task definitions |

## Atlas vector index (`chunk_vector_index` on `procurement.chunks`)
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
    { "type": "filter", "path": "embeddingModel" },
    { "type": "filter", "path": "documentId" }
  ]
}
```

## One-time setup
1. VPC with private subnets for tasks and public subnets for the ALB.
2. ECS cluster `procurement-ai`, services `procurement-api` and `procurement-worker` (Fargate, private subnets).
3. ALB + target group (IP type, port 4000, health check `/health`), listener 443 → target group.
4. Secrets in Secrets Manager: `procurement/openai-api-key`, `procurement/jwt-secret`, `procurement/mongo-url`, `procurement/redis-url`, `procurement/kafka-brokers`, `procurement/langsmith-api-key`.
5. IAM: execution role (ECR pull, logs, `secretsmanager:GetSecretValue`), task roles scoped to the S3 bucket.

## Deploy
```bash
AWS_ACCOUNT_ID=123456789012 AWS_REGION=us-east-1 S3_BUCKET=my-procurement-docs ./infra/aws/deploy.sh
```
