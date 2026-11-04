import type { NextFunction, Request, Response } from 'express';
import { checkPrompt } from '../lib/guardrails.js';
import { scrubPii } from '../lib/pii.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { audit } from '../services/mongo.js';
import { getRedis } from '../services/semanticCache.js';

/** Blocks prompt-injection / jailbreak patterns before anything reaches the agent. */
export async function promptInjectionGuard(req: Request, _res: Response, next: NextFunction) {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const verdict = checkPrompt(message);
  if (verdict.allowed) return next();
  logger.warn('guardrail blocked prompt', { rule: verdict.rule, user: req.user?.sub, requestId: req.requestId });
  try {
    await getRedis().incr('guardrail_stats:blocked');
    if (req.user) await audit('guardrail.blocked', req.user, { rule: verdict.rule });
  } catch { /* stats are best-effort */ }
  next(new HttpError(422, `Request blocked by security guardrail: ${verdict.reason}`, 'guardrail_blocked', { rule: verdict.rule }));
}

/** Scrubs PII from the user message in-flight; the agent and LLM only ever see the redacted text. */
export function piiScrubber(req: Request, res: Response, next: NextFunction) {
  if (typeof req.body?.message === 'string') {
    const { text, findings } = scrubPii(req.body.message);
    req.body.message = text;
    res.locals.pii = findings;
  }
  next();
}
