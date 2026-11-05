import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors.js';
import { rateLimited } from '../lib/metrics.js';
import { getTenant } from '../services/tenants.js';
import { consumeRateLimit, isOverBudget } from '../services/usage.js';

/** Resolves the caller's tenant (settings snapshot) onto res.locals.tenant. */
export async function loadTenant(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || req.user.role === 'ADMIN') return next(new HttpError(403, 'This endpoint requires a tenant user', 'forbidden'));
    res.locals.tenant = await getTenant(req.user.tenantId);
    next();
  } catch (err) {
    next(new HttpError(403, `Tenant not provisioned: ${(err as Error).message}`, 'tenant_unknown'));
  }
}

/** Per-user fixed-window rate limit + per-tenant monthly budget guard (run after loadTenant). */
export async function rateLimitAndBudget(req: Request, res: Response, next: NextFunction) {
  const tenant = res.locals.tenant;
  const user = req.user!;
  const rl = await consumeRateLimit(`${user.tenantId}:${user.sub}`, tenant.settings.limits.rateLimitPerMinute);
  res.setHeader('X-RateLimit-Limit', String(tenant.settings.limits.rateLimitPerMinute));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (!rl.allowed) {
    rateLimited.inc({ tenant: user.tenantId, reason: 'rate_limit' });
    res.setHeader('Retry-After', String(rl.retryAfter));
    return next(new HttpError(429, `Rate limit of ${tenant.settings.limits.rateLimitPerMinute} requests/minute exceeded. Retry in ${rl.retryAfter}s.`, 'rate_limited'));
  }
  if (await isOverBudget(user.tenantId, tenant.settings.limits.monthlyBudgetUsd)) {
    rateLimited.inc({ tenant: user.tenantId, reason: 'budget' });
    return next(new HttpError(402, `Monthly AI budget of $${tenant.settings.limits.monthlyBudgetUsd} reached for ${tenant.name}. Ask your admin to raise it.`, 'budget_exceeded'));
  }
  next();
}
