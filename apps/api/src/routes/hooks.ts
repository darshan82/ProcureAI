/**
 * A stand-in for a customer's ERP (SAP Ariba / Coupa / Oracle) receiving ProcureAI webhooks.
 * It verifies the HMAC signature exactly like a customer would and records what it received,
 * so the whole integration loop is demoable locally. MOCK_ERP_FAIL_RATE (0..1) simulates an
 * unreliable customer endpoint to exercise retries and the dead-letter queue.
 */
import express, { Router } from 'express';
import { verify } from '../lib/webhookSignature.js';
import { logger } from '../lib/logger.js';
import { getDb } from '../services/mongo.js';
import { getTenant } from '../services/tenants.js';

export const hooksRouter = Router();

hooksRouter.post('/mock-erp/:tenantId', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const tenantId = String(req.params.tenantId);
  const raw = typeof req.body === 'string' ? req.body : '';
  const failRate = Number(process.env.MOCK_ERP_FAIL_RATE ?? 0);
  if (failRate > 0 && Math.random() < failRate) return res.status(503).json({ error: 'ERP temporarily unavailable (simulated)' });

  const tenant = await getTenant(tenantId).catch(() => null);
  const hook = tenant?.settings.webhooks.find((w) => w.url.includes(`/hooks/mock-erp/${tenantId}`));
  if (!hook) return res.status(404).json({ error: 'unknown tenant endpoint' });
  const check = verify(hook.secret, raw, req.header('x-procureai-signature'));
  let event: any = {};
  try { event = JSON.parse(raw); } catch { /* recorded as unparseable */ }
  await getDb().collection('webhook_receipts').insertOne({
    tenantId, eventId: event.eventId, type: event.type, verified: check.ok, reason: check.reason,
    deliveryId: req.header('x-procureai-delivery'), receivedAt: new Date(),
  });
  if (!check.ok) {
    logger.warn('mock ERP rejected webhook', { tenantId, reason: check.reason });
    return res.status(401).json({ error: check.reason });
  }
  res.status(200).json({ received: true, erpReference: `ERP-${Date.now().toString(36).toUpperCase()}` });
});
