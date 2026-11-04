/** Central, typed configuration. Everything comes from env vars (see /.env.example). */
const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

function resolveOpenAiKey(): string {
  const key = env('OPENAI_API_KEY');
  // Treat the placeholder from .env.example as "no key" so the app falls back to mock mode.
  if (!key || key.startsWith('sk-your') || key === 'changeme') return '';
  return key;
}

const openaiKey = resolveOpenAiKey();

export const config = {
  port: Number(env('PORT', '4000')),
  nodeEnv: env('NODE_ENV', 'development'),
  corsOrigin: env('CORS_ORIGIN', '*'),
  jwtSecret: env('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '8h'),
  demoPassword: env('DEMO_PASSWORD', 'demo123'),

  llm: {
    mode: (openaiKey ? 'openai' : 'mock') as 'openai' | 'mock',
    openaiKey,
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    embeddingModel: env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDim: Number(env('OPENAI_EMBEDDING_DIM', '1536')),
  },

  mongo: {
    url: env('MONGO_URL', 'mongodb://localhost:27017'),
    db: env('MONGO_DB', 'procurement'),
    /** 'atlas' uses $vectorSearch (MongoDB Atlas / atlas-local); 'local' does cosine in the app. */
    vectorSearch: env('MONGO_VECTOR_SEARCH', 'local') as 'atlas' | 'local',
    vectorIndex: env('MONGO_VECTOR_INDEX', 'chunk_vector_index'),
  },

  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),

  kafka: {
    brokers: env('KAFKA_BROKERS', 'localhost:29092').split(','),
    clientId: env('KAFKA_CLIENT_ID', 'procurement-api'),
    ingestTopic: env('KAFKA_INGEST_TOPIC', 'document.ingest'),
  },

  s3: {
    endpoint: env('S3_ENDPOINT') || undefined,
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', 'procurement-documents'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },

  cache: {
    enabled: env('SEMANTIC_CACHE_ENABLED', 'true') === 'true',
    threshold: Number(env('SEMANTIC_CACHE_THRESHOLD', '0.92')),
    ttlSeconds: Number(env('SEMANTIC_CACHE_TTL_SECONDS', '3600')),
  },

  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '25')) * 1024 * 1024,
};

export type AppConfig = typeof config;
