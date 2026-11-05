/**
 * Integration dispatcher: consumes domain events (procurement.events) and delivers them to each
 * tenant's subscribed webhooks (ERP / Slack / data warehouse) with:
 *  - HMAC signatures + timestamp (replay protection), delivery id header (receiver idempotency)
 *  - per-attempt timeout, exponential backoff retries
 *  - idempotent bookkeeping in `webhook_deliveries` (a redelivered Kafka message is not resent)
 *  - dead-letter topic after the final attempt, with admin replay via the API
 */
import type { Db } from 'mongodb';
import type { Producer } from 'kafkajs';
import { logger } from './logger.js';
import { sign } from './signature.js';
import { webhookDeliveries, webhookLatency } from './metrics.js';

export const EVENTS_TOPIC = process.env.KAFKA_EVENTS_TOPIC ?? 'procurement.events';
export const EVENTS_DLQ_TOPIC = `${EVENTS_TOPIC}.dlq`;
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 3);
const BASE_BACKOFF_MS = Number(process.env.WEBHOOK_BACKOFF_MS ?? 500);
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5000);

interface Webhook { id: string; url: string; secret: string; events: string[] }
interface DomainEvent { eventId: string; type: string; tenantId: string; occurredAt: string; data: unknown; replayFor?: string }

const tenantCache = new Map<string, { hooks: Webhook[]; at: number }>();

async function webhooksFor(db: Db, tenantId: string): Promise<Webhook[]> {
  const hit = tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < 15_000) return hit.hooks;
  const t = await db.collection('tenants').findOne({ tenantId }, { projection: { 'settings.webhooks': 1 } });
  const hooks = (t?.settings?.webhooks ?? []) as Webhook[];
  tenantCache.set(tenantId, { hooks, at: Date.now() });
  return hooks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(hook: Webhook, body: string, ev: DomainEvent, deliveryId: string, n: number) {
  const end = webhookLatency.startTimer();
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ProcureAI-Webhooks/2.0',
        'x-procureai-event': ev.type,
        'x-procureai-delivery': deliveryId,
        'x-procureai-attempt': String(n),
        'x-procureai-signature': sign(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  } finally {
    end();
  }
}

export async function dispatchEvent(db: Db, producer: Producer, ev: DomainEvent, heartbeat: () => Promise<void>) {
  const hooks = (await webhooksFor(db, ev.tenantId)).filter((h) => (ev.replayFor ? h.id === ev.replayFor : h.events.includes(ev.type)));
  const deliveries = db.collection('webhook_deliveries');
  for (const hook of hooks) {
    const deliveryId = `${ev.eventId}:${hook.id}`;
    const existing = await deliveries.findOne({ deliveryId }, { projection: { status: 1 } });
    if (existing?.status === 'DELIVERED' && !ev.replayFor) continue; // idempotent on Kafka redelivery

    const { replayFor: _r, ...clean } = ev;
    const body = JSON.stringify(clean);
    let result = { ok: false, status: 0, error: undefined as string | undefined };
    let attempts = 0;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      attempts = n;
      result = await attempt(hook, body, ev, deliveryId, n);
      if (result.ok || (result.status >= 400 && result.status < 500 && result.status !== 429)) break; // 4xx (except 429) is not retryable
      if (n < MAX_ATTEMPTS) { await heartbeat(); await sleep(BASE_BACKOFF_MS * 2 ** (n - 1)); }
    }
    const status = result.ok ? 'DELIVERED' : 'DEAD_LETTERED';
    await deliveries.updateOne(
      { deliveryId },
      {
        $set: { tenantId: ev.tenantId, webhookId: hook.id, url: hook.url, eventId: ev.eventId, type: ev.type, status, attempts, lastStatusCode: result.status, lastError: result.error ?? null, payload: clean, updatedAt: new Date() },
        $setOnInsert: { deliveryId, createdAt: new Date() },
        $inc: { totalAttempts: attempts },
      },
      { upsert: true },
    );
    webhookDeliveries.inc({ tenant: ev.tenantId, status: status.toLowerCase() });
    if (!result.ok) {
      await producer.send({ topic: EVENTS_DLQ_TOPIC, messages: [{ key: ev.tenantId, value: body, headers: { webhook: hook.id, error: result.error ?? 'unknown' } }] });
      logger.warn('webhook dead-lettered', { tenantId: ev.tenantId, webhook: hook.id, type: ev.type, attempts, error: result.error });
    } else {
      logger.info('webhook delivered', { tenantId: ev.tenantId, webhook: hook.id, type: ev.type, attempts });
    }
  }
}
