/** Platform operator (forward-deployed engineer) console API: onboarding, tuning, usage, integrations. */
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { getDb } from '../services/mongo.js';
import { EVENTS_TOPIC, republishRaw } from '../services/kafka.js';
import { createTenant, getTenant, listTenants, redactTenant, TenantSchema, TenantSettingsSchema, updateTenantSettings } from '../services/tenants.js';
import { getUsage, MODEL_PRICING } from '../services/usage.js';
import { circuitSnapshot } from '../agent/llmGateway.js';
import { config } from '../config.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ADMIN'));

adminRouter.get('/tenants', async (_req, res) => {
  const tenants = await listTenants();
  const rows = await Promise.all(tenants.map(async (t) => ({ ...redactTenant(t), usage: await getUsage(t.tenantId) })));
  res.json({ tenants: rows });
});

adminRouter.post('/tenants', async (req, res) => {
  const t = TenantSchema.parse(req.body);
  if (await getTenant(t.tenantId).catch(() => null)) throw new HttpError(409, `Tenant ${t.tenantId} already exists`, 'conflict');
  await createTenant(t);
  res.status(201).json({ tenant: redactTenant(t) });
});

adminRouter.patch('/tenants/:tenantId/settings', async (req, res) => {
  const patch = TenantSettingsSchema.partial().parse(req.body);
  const t = await updateTenantSettings(String(req.params.tenantId), patch);
  await getDb().collection('audit_log').insertOne({ tenantId: t.tenantId, event: 'tenant.settings.updated', actor: req.user!.sub, role: 'ADMIN', data: { fields: Object.keys(patch) }, at: new Date() });
  res.json({ tenant: redactTenant(t) });
});

adminRouter.get('/tenants/:tenantId/usage', async (req, res) => {
  res.json({ usage: await getUsage(String(req.params.tenantId)) });
});

adminRouter.get('/deliveries', async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.tenantId === 'string') filter.tenantId = req.query.tenantId;
  if (typeof req.query.status === 'string') filter.status = req.query.status;
  const rows = await getDb().collection('webhook_deliveries').find(filter, { projection: { _id: 0, payload: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ deliveries: rows });
});

/** Re-drive a failed delivery (e.g. after the customer fixed their endpoint). */
adminRouter.post('/deliveries/:deliveryId/replay', async (req, res) => {
  const d = await getDb().collection('webhook_deliveries').findOne({ deliveryId: req.params.deliveryId });
  if (!d) throw new HttpError(404, 'Delivery not found', 'not_found');
  const event = { ...(d.payload as Record<string, unknown>), replayFor: d.webhookId };
  await republishRaw(EVENTS_TOPIC, String(d.tenantId), JSON.stringify(event));
  res.status(202).json({ replayed: true, eventId: d.eventId, webhookId: d.webhookId });
});

adminRouter.get('/receipts', async (req, res) => {
  const filter = typeof req.query.tenantId === 'string' ? { tenantId: req.query.tenantId } : {};
  const rows = await getDb().collection('webhook_receipts').find(filter, { projection: { _id: 0 } }).sort({ receivedAt: -1 }).limit(50).toArray();
  res.json({ receipts: rows });
});

adminRouter.get('/llm', (_req, res) => {
  res.json({ mode: config.llm.mode, circuits: circuitSnapshot(), pricingPerMillionTokens: MODEL_PRICING });
});

adminRouter.get('/audit', async (req, res) => {
  const filter = typeof req.query.tenantId === 'string' ? { tenantId: req.query.tenantId } : {};
  const rows = await getDb().collection('audit_log').find(filter, { projection: { _id: 0 } }).sort({ at: -1 }).limit(100).toArray();
  res.json({ events: rows });
});

