/**
 * Semantic cache on Redis Stack (RediSearch HNSW vector index, COSINE distance).
 * Lookup: embed the query -> KNN 1 within the caller's role -> hit if similarity >= threshold.
 * Write-through: populated after a successful, read-only agent run.
 * Invalidation: flushed whenever data changes (tool mutations, new documents ingested).
 */
import { createClient } from 'redis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { embedQuery, embeddingInfo } from './embeddings.js';

type Redis = ReturnType<typeof createClient>;
let redis: Redis | null = null;

// Key layout: semcache:{dim}:{tenant}:{role}:{ts}:{rand}. Index v2 adds the tenant TAG.
const PREFIX = `semcache:${embeddingInfo.dim}:`;
const INDEX = `idx:semcache:v2:${embeddingInfo.dim}`;

export async function connectRedis(): Promise<Redis> {
  if (redis) return redis;
  redis = createClient({ url: config.redisUrl });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));
  await redis.connect();
  await ensureIndex();
  logger.info('redis connected', { index: INDEX });
  return redis;
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis not connected');
  return redis;
}

const toBuffer = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

async function ensureIndex() {
  const r = getRedis();
  try {
    await r.sendCommand(['FT.INFO', INDEX]);
  } catch {
    await r.sendCommand([
      'FT.CREATE', INDEX, 'ON', 'HASH', 'PREFIX', '1', PREFIX,
      'SCHEMA',
      'tenant', 'TAG',
      'role', 'TAG',
      'query', 'TEXT',
      'embedding', 'VECTOR', 'HNSW', '6', 'TYPE', 'FLOAT32', 'DIM', String(embeddingInfo.dim), 'DISTANCE_METRIC', 'COSINE',
    ]);
    logger.info('created redis vector index', { index: INDEX, dim: embeddingInfo.dim });
  }
}

/** Normalises FT.SEARCH replies across RESP2 (flat arrays) and RESP3 (maps), i.e. Redis Stack 7.x and Redis 8. */
function firstResult(reply: unknown): Record<string, string> | null {
  if (Array.isArray(reply)) {
    if (Number(reply[0]) === 0 || !Array.isArray(reply[2])) return null;
    const fields = reply[2] as unknown[];
    const rec: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) rec[String(fields[i])] = String(fields[i + 1]);
    return rec;
  }
  const r = reply as { results?: Array<{ extra_attributes?: Record<string, unknown> }> } | Map<string, unknown>;
  const results = r instanceof Map ? (r.get('results') as any[]) : r?.results;
  const first = results?.[0];
  if (!first) return null;
  const attrs = first instanceof Map ? first.get('extra_attributes') : first.extra_attributes;
  const entries = attrs instanceof Map ? [...attrs.entries()] : Object.entries(attrs ?? {});
  return Object.fromEntries(entries.map(([k, v]) => [String(k), String(v)]));
}

export interface CacheHit {
  answer: string;
  matchedQuery: string;
  similarity: number;
  lookupMs: number;
}

const tagSafe = (v: string) => v.replace(/[^a-zA-Z0-9_]/g, '_');

export async function lookup(query: string, tenantId: string, role: string, threshold = config.cache.threshold): Promise<{ hit: CacheHit | null; vector: number[]; bestSimilarity: number | null; lookupMs: number }> {
  const t0 = performance.now();
  const vector = await embedQuery(query);
  const reply = await getRedis().sendCommand([
    'FT.SEARCH', INDEX, `(@tenant:{${tagSafe(tenantId)}} @role:{${role}})=>[KNN 1 @embedding $vec AS dist]`,
    'PARAMS', '2', 'vec', toBuffer(vector),
    'RETURN', '3', 'dist', 'answer', 'query',
    'SORTBY', 'dist', 'DIALECT', '2',
  ]);
  const lookupMs = Math.round((performance.now() - t0) * 10) / 10;
  const rec = firstResult(reply);
  if (!rec) return { hit: null, vector, bestSimilarity: null, lookupMs };
  const similarity = 1 - Number(rec.dist);
  const rounded = Math.round(similarity * 1000) / 1000;
  if (similarity >= threshold) {
    return { hit: { answer: rec.answer, matchedQuery: rec.query, similarity: rounded, lookupMs }, vector, bestSimilarity: rounded, lookupMs };
  }
  return { hit: null, vector, bestSimilarity: rounded, lookupMs };
}

export async function store(query: string, tenantId: string, role: string, answer: string, vector?: number[]) {
  const vec = vector ?? (await embedQuery(query));
  const key = `${PREFIX}${tagSafe(tenantId)}:${role}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const r = getRedis();
  await r.sendCommand(['HSET', key, 'tenant', tagSafe(tenantId), 'role', role, 'query', query, 'answer', answer, 'createdAt', new Date().toISOString(), 'embedding', toBuffer(vec)]);
  await r.expire(key, config.cache.ttlSeconds);
}

/** Drop a tenant's cached answers (all roles). Called after any write that changes that tenant's ground truth. */
export async function invalidateTenant(tenantId: string, reason: string): Promise<number> {
  const r = getRedis();
  let deleted = 0;
  for await (const keys of r.scanIterator({ MATCH: `semcache:*:${tagSafe(tenantId)}:*`, COUNT: 500 })) {
    const batch = Array.isArray(keys) ? keys : [keys];
    if (batch.length) deleted += await r.del(batch);
  }
  logger.info('semantic cache invalidated', { tenantId, reason, deleted });
  return deleted;
}

export async function cacheStats(tenantId: string) {
  const r = getRedis();
  let entries = 0;
  for await (const keys of r.scanIterator({ MATCH: `${PREFIX}${tagSafe(tenantId)}:*`, COUNT: 500 })) {
    entries += Array.isArray(keys) ? keys.length : 1;
  }
  const [hits, misses] = await Promise.all([r.get(`semcache_stats:${tenantId}:hits`), r.get(`semcache_stats:${tenantId}:misses`)]);
  return { entries, hits: Number(hits ?? 0), misses: Number(misses ?? 0), index: INDEX };
}

export async function recordStat(tenantId: string, kind: 'hits' | 'misses') {
  await getRedis().incr(`semcache_stats:${tenantId}:${kind}`);
}
