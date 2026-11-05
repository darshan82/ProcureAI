import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { bids, getDb, tenders } from '../services/mongo.js';
import { getTenant, redactTenant } from '../services/tenants.js';
import { getUsage } from '../services/usage.js';

export const tendersRouter = Router();
tendersRouter.use(requireAuth, requireRole('BUYER', 'SUPPLIER'));

tendersRouter.get('/', async (req, res) => {
  const filter: Record<string, unknown> = { tenantId: req.user!.tenantId };
  if (typeof req.query.status === 'string') filter.status = req.query.status.toUpperCase();
  const rows = await tenders().find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ tenders: rows });
});

tendersRouter.get('/mine/bids', requireRole('SUPPLIER'), async (req, res) => {
  const rows = await bids().find({ tenantId: req.user!.tenantId, supplier: req.user!.sub }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  res.json({ bids: rows });
});

tendersRouter.get('/:tenderId/bids', requireRole('BUYER'), async (req, res) => {
  const rows = await bids().find({ tenantId: req.user!.tenantId, tenderId: String(req.params.tenderId).toUpperCase() }, { projection: { _id: 0 } }).sort({ amount: 1 }).toArray();
  res.json({ bids: rows });
});

export const auditRouter = Router();
auditRouter.get('/', requireAuth, requireRole('BUYER'), async (req, res) => {
  const rows = await getDb().collection('audit_log').find({ tenantId: req.user!.tenantId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray();
  res.json({ events: rows });
});

/** The caller's own tenant: name, policies and this month's AI usage (secrets redacted). */
export const tenantRouter = Router();
tenantRouter.get('/', requireAuth, requireRole('BUYER', 'SUPPLIER'), async (req, res) => {
  const t = await getTenant(req.user!.tenantId);
  const safe = redactTenant(t);
  res.json({ tenant: { ...safe, settings: { ...safe.settings, webhooks: req.user!.role === 'BUYER' ? safe.settings.webhooks : [] } }, usage: await getUsage(t.tenantId) });
});
