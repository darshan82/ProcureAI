import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../services/mongo.js';
import { getRedis } from '../services/semanticCache.js';
import { embeddingInfo } from '../services/embeddings.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()) }));

healthRouter.get('/ready', async (_req, res) => {
  const checks: Record<string, string> = {};
  try { await getDb().command({ ping: 1 }); checks.mongo = 'ok'; } catch (e) { checks.mongo = String(e); }
  try { await getRedis().ping(); checks.redis = 'ok'; } catch (e) { checks.redis = String(e); }
  const ok = Object.values(checks).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'degraded', checks,
    llm: { mode: config.llm.mode, model: config.llm.mode === 'openai' ? config.llm.model : 'mock', embeddings: embeddingInfo.model },
    langsmith: process.env.LANGSMITH_TRACING === 'true' ? 'enabled' : 'disabled',
  });
});
