const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;
const rawKey = env('OPENAI_API_KEY');
const openaiKey = !rawKey || rawKey.startsWith('sk-your') || rawKey === 'changeme' ? '' : rawKey;

export const config = {
  llm: {
    mode: (openaiKey ? 'openai' : 'mock') as 'openai' | 'mock',
    openaiKey,
    embeddingModel: env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDim: Number(env('OPENAI_EMBEDDING_DIM', '1536')),
  },
  mongo: { url: env('MONGO_URL', 'mongodb://localhost:27017'), db: env('MONGO_DB', 'procurement') },
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  kafka: {
    brokers: env('KAFKA_BROKERS', 'localhost:29092').split(','),
    clientId: env('KAFKA_CLIENT_ID', 'procurement-worker'),
    groupId: env('KAFKA_GROUP_ID', 'ingestion-workers'),
    ingestTopic: env('KAFKA_INGEST_TOPIC', 'document.ingest'),
  },
  s3: {
    endpoint: env('S3_ENDPOINT') || undefined,
    region: env('S3_REGION', 'us-east-1'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },
  chunk: { size: Number(env('CHUNK_SIZE', '1000')), overlap: Number(env('CHUNK_OVERLAP', '150')) },
  embedBatchSize: Number(env('EMBED_BATCH_SIZE', '64')),
  healthPort: Number(env('HEALTH_PORT', '4001')),
};
