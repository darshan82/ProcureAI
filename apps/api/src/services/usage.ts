/**
 * Per-tenant metering + rate limiting backed by Redis.
 *  - Token/cost usage per tenant per month (hash usage:{tenant}:{YYYY-MM}), per model.
 *  - Monthly budget enforcement (HTTP 402 when exceeded).
 *  - Fixed-window rate limit per user per minute (HTTP 429 + Retry-After).
 */
import { getRedis } from './semanticCache.js';
import { llmCost, llmTokens } from '../lib/metrics.js';

/** USD per 1M tokens [input, output]. Update when pricing changes; unknown models fall back to 'default'. */
export const MODEL_PRICING: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  'gpt-4o': [2.5, 10],
  mock: [0, 0],
  default: [1, 4],
};

const month = () => new Date().toISOString().slice(0, 7);
const usageKey = (tenantId: string) => `usage:${tenantId}:${month()}`;

export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const [i, o] = MODEL_PRICING[model] ?? MODEL_PRICING.default;
  return (inputTokens * i + outputTokens * o) / 1_000_000;
}

export async function recordUsage(tenantId: string, model: string, inputTokens: number, outputTokens: number) {
  const cost = costOf(model, inputTokens, outputTokens);
  const key = usageKey(tenantId);
  const r = getRedis();
  await r.multi()
    .hIncrBy(key, 'requests', 1)
    .hIncrBy(key, 'inputTokens', inputTokens)
    .hIncrBy(key, 'outputTokens', outputTokens)
    .hIncrBy(key, 'costMicroUsd', Math.round(cost * 1_000_000))
    .hIncrBy(key, `model:${model}:requests`, 1)
    .expire(key, 60 * 60 * 24 * 400)
    .exec();
  llmTokens.inc({ tenant: tenantId, model, type: 'input' }, inputTokens);
  llmTokens.inc({ tenant: tenantId, model, type: 'output' }, outputTokens);
  llmCost.inc({ tenant: tenantId, model }, cost);
  return cost;
}

export async function getUsage(tenantId: string) {
  const raw = await getRedis().hGetAll(usageKey(tenantId));
  const models: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = k.match(/^model:(.+):requests$/);
    if (m) models[m[1]] = Number(v);
  }
  return {
    month: month(),
    requests: Number(raw.requests ?? 0),
    inputTokens: Number(raw.inputTokens ?? 0),
    outputTokens: Number(raw.outputTokens ?? 0),
    costUsd: Number(raw.costMicroUsd ?? 0) / 1_000_000,
    models,
  };
}

export async function isOverBudget(tenantId: string, budgetUsd: number): Promise<boolean> {
  if (budgetUsd <= 0) return false;
  const micro = Number((await getRedis().hGet(usageKey(tenantId), 'costMicroUsd')) ?? 0);
  return micro / 1_000_000 >= budgetUsd;
}

/** Fixed 60s window. Returns remaining requests or retryAfter seconds when blocked. */
export async function consumeRateLimit(subject: string, limitPerMinute: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const windowStart = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${subject}:${windowStart}`;
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, 61);
  const retryAfter = 60 - Math.floor((Date.now() / 1000) % 60);
  return { allowed: count <= limitPerMinute, remaining: Math.max(0, limitPerMinute - count), retryAfter };
}
