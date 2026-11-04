import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { bids, getDb, tenders } from '../services/mongo.js';

export const tendersRouter = Router();

tendersRouter.get('/', requireAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const rows = await tenders().find(status ? { status: status as any } : {}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ tenders: rows });
});

tendersRouter.get('/:tenderId/bids', requireAuth, requireRole('BUYER'), async (req, res) => {
  const rows = await bids().find({ tenderId: String(req.params.tenderId).toUpperCase() }, { projection: { _id: 0 } }).sort({ amount: 1 }).toArray();
  res.json({ bids: rows });
});

tendersRouter.get('/mine/bids', requireAuth, requireRole('SUPPLIER'), async (req, res) => {
  const rows = await bids().find({ supplier: req.user!.sub }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  res.json({ bids: rows });
});

export const auditRouter = Router();
auditRouter.get('/', requireAuth, requireRole('BUYER'), async (_req, res) => {
  const rows = await getDb().collection('audit_log').find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(50).toArray();
  res.json({ events: rows });
});
