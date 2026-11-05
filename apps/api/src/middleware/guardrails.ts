import type { NextFunction, Request, Response } from 'express';
import { checkPrompt } from '../lib/guardrails.js';
import { scrubPii } from '../lib/pii.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { guardrailBlocks, piiRedactions } from '../lib/metrics.js';
import { audit } from '../services/mongo.js';
import { getRedis } from '../services/semanticCache.js';

/** Blocks prompt-injection / jailbreak patterns before anything reaches the agent. */
export async function promptInjectionGuard(req: Request, _res: Response, next: NextFunction) {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const verdict = checkPrompt(message);
  if (verdict.allowed) return next();
  const tenant = req.user?.tenantId ?? 'unknown';
  guardrailBlocks.inc({ tenant, rule: verdict.rule ?? 'unknown' });
  logger.warn('guardrail blocked prompt', { rule: verdict.rule, user: req.user?.sub, tenant, requestId: req.requestId });
  try {
    await getRedis().incr(`guardrail_stats:${tenant}:blocked`);
    if (req.user) await audit('guardrail.blocked', req.user, { rule: verdict.rule });
  } catch { /* stats are best-effort */ }
  next(new HttpError(422, `Request blocked by security guardrail: ${verdict.reason}`, 'guardrail_blocked', { rule: verdict.rule }));
}

/**
 * Applies the tenant's PII policy to the user message:
 *  - redact: the agent and LLM only ever see the redacted text
 *  - block:  regulated tenants reject messages containing PII outright
 */
export function piiPolicy(req: Request, res: Response, next: NextFunction) {
  if (typeof req.body?.message !== 'string') return next();
  const { text, findings } = scrubPii(req.body.message);
  res.locals.pii = findings;
  const tenant = res.locals.tenant;
  if (findings.length && tenant?.settings.piiPolicy === 'block') {
    guardrailBlocks.inc({ tenant: tenant.tenantId, rule: 'pii_policy_block' });
    return next(new HttpError(422, `${tenant.name} policy forbids sending personal data (${findings.map((f) => f.type).join(', ')}) to the AI assistant. Remove it and try again.`, 'pii_blocked', { findings }));
  }
  for (const f of findings) piiRedactions.inc({ tenant: req.user?.tenantId ?? 'unknown', type: f.type }, f.count);
  req.body.message = text;
  next();
}
