#!/usr/bin/env bash
# Build -> push to ECR -> register ECS task definitions -> roll the Fargate services.
# Prereqs: AWS CLI v2 logged in, ECS cluster + services + ALB target group already created
# (see infra/aws/README.md), secrets stored in AWS Secrets Manager.
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
: "${AWS_REGION:?set AWS_REGION}"
: "${S3_BUCKET:?set S3_BUCKET}"
CLUSTER="${ECS_CLUSTER:-procurement-ai}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export AWS_ACCOUNT_ID AWS_REGION S3_BUCKET IMAGE_TAG

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for svc in api worker; do
  repo="procurement-${svc}"
  aws ecr describe-repositories --repository-names "$repo" --region "$AWS_REGION" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "$repo" --image-scanning-configuration scanOnPush=true --region "$AWS_REGION" >/dev/null
  docker build --platform linux/amd64 -t "$REGISTRY/$repo:$IMAGE_TAG" "$ROOT/apps/$svc"
  docker push "$REGISTRY/$repo:$IMAGE_TAG"

  envsubst < "$ROOT/infra/aws/ecs-task-${svc}.json" > "/tmp/ecs-task-${svc}.json"
  arn=$(aws ecs register-task-definition --cli-input-json "file:///tmp/ecs-task-${svc}.json" --region "$AWS_REGION" --query 'taskDefinition.taskDefinitionArn' --output text)
  aws ecs update-service --cluster "$CLUSTER" --service "procurement-${svc}" --task-definition "$arn" --region "$AWS_REGION" >/dev/null
  echo "deployed $svc -> $arn"
done

aws ecs wait services-stable --cluster "$CLUSTER" --services procurement-api procurement-worker --region "$AWS_REGION"
echo "✅ services stable"
