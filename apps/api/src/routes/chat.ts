import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { piiScrubber, promptInjectionGuard } from '../middleware/guardrails.js';
import { CACHEABLE_INTENTS, classifyIntent } from '../agent/intent.js';
import { hasPendingApproval, runAgent } from '../agent/runner.js';
import { MUTATING_TOOLS } from '../agent/state.js';
import * as cache from '../services/semanticCache.js';

export const chatRouter = Router();

const ChatBody = z.object({ message: z.string().min(1), threadId: z.string().max(80).optional() });
const ResumeBody = z.object({ threadId: z.string().max(80), approved: z.boolean(), comment: z.string().max(500).optional() });

/** Threads are namespaced by user so one user can never resume / read another user's thread. */
const threadKey = (sub: string, threadId: string) => `${sub}::${threadId}`;

chatRouter.post('/', requireAuth, promptInjectionGuard, piiScrubber, async (req, res) => {
  const body = ChatBody.parse(req.body);
  const user = req.user!;
  const threadId = body.threadId || randomUUID();
  const key = threadKey(user.sub, threadId);
  const t0 = performance.now();
  const pii = res.locals.pii ?? [];

  if (await hasPendingApproval(key, user)) {
    throw new HttpError(409, 'This thread is waiting for an approval decision. Approve or reject first.', 'approval_pending');
  }

  // 1) Semantic cache interceptor (read-only intents only).
  const intent = classifyIntent(body.message);
  let vector: number[] | undefined;
  let cacheInfo: Record<string, unknown> = { hit: false, eligible: false };
  if (config.cache.enabled && CACHEABLE_INTENTS.includes(intent)) {
    const r = await cache.lookup(body.message, user.role);
    vector = r.vector;
    if (r.hit) {
      await cache.recordStat('hits');
      return res.json({
        status: 'completed', threadId, answer: r.hit.answer, intent, toolsUsed: [], pii,
        cache: { hit: true, eligible: true, similarity: r.hit.similarity, matchedQuery: r.hit.matchedQuery, lookupMs: r.hit.lookupMs },
        latencyMs: Math.round(performance.now() - t0), trace: [{ node: 'semantic_cache', ms: Math.round(r.lookupMs), detail: `hit (similarity ${r.hit.similarity})` }],
        llmMode: config.llm.mode,
      });
    }
    await cache.recordStat('misses');
    cacheInfo = { hit: false, eligible: true, bestSimilarity: r.bestSimilarity, lookupMs: r.lookupMs };
  }

  // 2) Agent run.
  const result = await runAgent({ threadKey: key, user, message: body.message });

  // 3) Write-through / invalidation.
  const mutated = result.toolsUsed.some((t) => MUTATING_TOOLS.has(t));
  if (mutated) {
    await cache.invalidateAll(`tool mutation: ${result.toolsUsed.join(',')}`);
  } else if (result.status === 'completed' && cacheInfo.eligible && result.toolsUsed.length > 0 && result.answer) {
    await cache.store(body.message, user.role, result.answer, vector);
    cacheInfo.stored = true;
  }

  const latencyMs = Math.round(performance.now() - t0);
  logger.info('chat turn', { user: user.sub, role: user.role, intent: result.intent, tools: result.toolsUsed, status: result.status, latencyMs, cacheHit: false });
  res.status(result.status === 'awaiting_approval' ? 202 : 200).json({ ...result, threadId, pii, cache: cacheInfo, latencyMs });
});

/** Human-in-the-loop decision for a paused graph (e.g. award_tender). */
chatRouter.post('/resume', requireAuth, requireRole('BUYER'), async (req, res) => {
  const body = ResumeBody.parse(req.body);
  const user = req.user!;
  const key = threadKey(user.sub, body.threadId);
  if (!(await hasPendingApproval(key, user))) throw new HttpError(404, 'No pending approval for this thread', 'not_found');
  const t0 = performance.now();
  const result = await runAgent({ threadKey: key, user, resume: { approved: body.approved, comment: body.comment, reviewer: user.sub } });
  if (result.toolsUsed.some((t) => MUTATING_TOOLS.has(t))) await cache.invalidateAll('hitl-approved mutation');
  res.json({ ...result, threadId: body.threadId, latencyMs: Math.round(performance.now() - t0), cache: { hit: false, eligible: false } });
});

chatRouter.get('/cache/stats', requireAuth, async (_req, res) => {
  const [stats, blocked] = await Promise.all([cache.cacheStats(), cache.getRedis().get('guardrail_stats:blocked')]);
  res.json({ ...stats, guardrailBlocked: Number(blocked ?? 0), llmMode: config.llm.mode });
});

chatRouter.delete('/cache', requireAuth, requireRole('BUYER'), async (_req, res) => {
  res.json({ deleted: await cache.invalidateAll('manual flush') });
});
