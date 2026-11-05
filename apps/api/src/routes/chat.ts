import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { cacheRequests } from '../lib/metrics.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { piiPolicy, promptInjectionGuard } from '../middleware/guardrails.js';
import { loadTenant, rateLimitAndBudget } from '../middleware/tenant.js';
import { CACHEABLE_INTENTS, classifyIntent } from '../agent/intent.js';
import { hasPendingApproval, streamAgent, type AgentEvent, type AgentResult } from '../agent/runner.js';
import { MUTATING_TOOLS, type UserContext } from '../agent/state.js';
import * as cache from '../services/semanticCache.js';
import { publishEvent } from '../services/kafka.js';
import type { Tenant } from '../services/tenants.js';

export const chatRouter = Router();

const ChatBody = z.object({ message: z.string().min(1), threadId: z.string().max(80).optional() });
const ResumeBody = z.object({ threadId: z.string().max(80), approved: z.boolean(), comment: z.string().max(500).optional() });

/** Threads are namespaced by tenant + user so nobody can resume / read another user's thread. */
const threadKey = (u: UserContext, threadId: string) => `${u.tenantId}::${u.sub}::${threadId}`;

type Emit = (ev: AgentEvent | { type: 'meta'; data: Record<string, unknown> }) => void;

/** One chat turn: semantic cache -> agent -> write-through / invalidation -> events. Shared by JSON and SSE. */
async function chatTurn(user: UserContext, tenant: Tenant, message: string, threadId: string, pii: unknown[], emit: Emit) {
  const key = threadKey(user, threadId);
  const t0 = performance.now();
  if (await hasPendingApproval(key, user)) {
    throw new HttpError(409, 'This thread is waiting for an approval decision. Approve or reject first.', 'approval_pending');
  }

  const intent = classifyIntent(message);
  const cacheCfg = tenant.settings.cache;
  let vector: number[] | undefined;
  let cacheInfo: Record<string, unknown> = { hit: false, eligible: false };
  if (config.cache.enabled && cacheCfg.enabled && CACHEABLE_INTENTS.includes(intent)) {
    const r = await cache.lookup(message, user.tenantId, user.role, cacheCfg.threshold);
    vector = r.vector;
    if (r.hit) {
      await cache.recordStat(user.tenantId, 'hits');
      cacheRequests.inc({ tenant: user.tenantId, result: 'hit' });
      const step = { node: 'semantic_cache', ms: Math.round(r.lookupMs), detail: `hit (similarity ${r.hit.similarity} ≥ ${cacheCfg.threshold})` };
      emit({ type: 'step', step });
      return {
        status: 'completed', threadId, answer: r.hit.answer, intent, toolsUsed: [], pii, piiRedactions: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0, models: [], fallbacks: [] },
        cache: { hit: true, eligible: true, similarity: r.hit.similarity, matchedQuery: r.hit.matchedQuery, lookupMs: r.hit.lookupMs, threshold: cacheCfg.threshold },
        latencyMs: Math.round(performance.now() - t0), trace: [step], llmMode: config.llm.mode, tenantId: user.tenantId,
      };
    }
    await cache.recordStat(user.tenantId, 'misses');
    cacheRequests.inc({ tenant: user.tenantId, result: 'miss' });
    cacheInfo = { hit: false, eligible: true, bestSimilarity: r.bestSimilarity, lookupMs: r.lookupMs, threshold: cacheCfg.threshold };
  }

  let result: AgentResult | undefined;
  for await (const ev of streamAgent({ threadKey: key, user, tenant: tenant.settings, message })) {
    if (ev.type === 'result') result = ev.result;
    else emit(ev);
  }
  if (!result) throw new Error('Agent produced no result');
  await afterRun(user, threadId, result, { message, vector, cacheInfo });

  const latencyMs = Math.round(performance.now() - t0);
  logger.info('chat turn', { tenant: user.tenantId, user: user.sub, intent: result.intent, tools: result.toolsUsed, status: result.status, latencyMs, costUsd: result.usage.costUsd });
  return { ...result, threadId, pii, cache: cacheInfo, latencyMs, tenantId: user.tenantId };
}

async function afterRun(user: UserContext, threadId: string, result: AgentResult, c?: { message: string; vector?: number[]; cacheInfo: Record<string, unknown> }) {
  if (result.toolsUsed.some((t) => MUTATING_TOOLS.has(t))) {
    await cache.invalidateTenant(user.tenantId, `tool mutation: ${result.toolsUsed.join(',')}`);
  } else if (c && result.status === 'completed' && c.cacheInfo.eligible && result.toolsUsed.length > 0 && result.answer) {
    await cache.store(c.message, user.tenantId, user.role, result.answer, c.vector);
    c.cacheInfo.stored = true;
  }
  if (result.status === 'awaiting_approval') {
    await publishEvent(user.tenantId, 'approval.requested', { threadId, requestedBy: user.sub, toolCalls: result.pending?.flatMap((p) => p.toolCalls) ?? [] }, user.sub);
  }
}

const guards = [requireAuth, requireRole('BUYER', 'SUPPLIER'), loadTenant, rateLimitAndBudget, promptInjectionGuard, piiPolicy];

chatRouter.post('/', ...guards, async (req, res) => {
  const body = ChatBody.parse(req.body);
  const out = await chatTurn(req.user!, res.locals.tenant, body.message, body.threadId || randomUUID(), res.locals.pii ?? [], () => {});
  res.status(out.status === 'awaiting_approval' ? 202 : 200).json(out);
});

/** Server-Sent Events: live graph steps and tokens, then a final `result` event. */
chatRouter.post('/stream', ...guards, async (req: Request, res: Response) => {
  const body = ChatBody.parse(req.body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let tokens = 0;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  try {
    const out = await chatTurn(req.user!, res.locals.tenant, body.message, body.threadId || randomUUID(), res.locals.pii ?? [], (ev) => {
      if (ev.type === 'step') send('step', ev.step);
      if (ev.type === 'token') { tokens++; send('token', { text: ev.text }); }
    });
    // Mock mode has no provider token stream: replay the answer in small chunks so the UX is identical.
    if (!tokens && out.status === 'completed' && out.answer) {
      for (const piece of out.answer.match(/\S+\s*/g) ?? []) send('token', { text: piece });
    }
    send('result', out);
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'Something went wrong', 'internal_error');
    if (!(err instanceof HttpError)) logger.error('stream error', { err: err instanceof Error ? err.stack : String(err) });
    send('error', { status: e.status, error: e.code, message: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

/** Human-in-the-loop decision for a paused graph (award_tender, large create_tender_db). */
chatRouter.post('/resume', requireAuth, requireRole('BUYER'), loadTenant, async (req, res) => {
  const body = ResumeBody.parse(req.body);
  const user = req.user!;
  const key = threadKey(user, body.threadId);
  if (!(await hasPendingApproval(key, user))) throw new HttpError(404, 'No pending approval for this thread', 'not_found');
  const t0 = performance.now();
  let result: AgentResult | undefined;
  for await (const ev of streamAgent({ threadKey: key, user, tenant: res.locals.tenant.settings, resume: { approved: body.approved, comment: body.comment, reviewer: user.sub } })) {
    if (ev.type === 'result') result = ev.result;
  }
  await afterRun(user, body.threadId, result!);
  res.json({ ...result, threadId: body.threadId, latencyMs: Math.round(performance.now() - t0), cache: { hit: false, eligible: false }, tenantId: user.tenantId });
});

chatRouter.get('/cache/stats', requireAuth, requireRole('BUYER', 'SUPPLIER'), loadTenant, async (req, res) => {
  const tenantId = req.user!.tenantId;
  const [stats, blocked] = await Promise.all([cache.cacheStats(tenantId), cache.getRedis().get(`guardrail_stats:${tenantId}:blocked`)]);
  res.json({ ...stats, threshold: res.locals.tenant.settings.cache.threshold, guardrailBlocked: Number(blocked ?? 0), llmMode: config.llm.mode });
});

chatRouter.delete('/cache', requireAuth, requireRole('BUYER'), async (req, res) => {
  res.json({ deleted: await cache.invalidateTenant(req.user!.tenantId, 'manual flush') });
});
