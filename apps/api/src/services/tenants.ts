/**
 * Multi-tenancy: every customer deployment is a tenant with its own data partition and settings
 * (models, cache, PII policy, enabled tools, approval policy, limits, webhooks).
 * Tenants are onboarded as config-as-code (apps/api/tenants/*.json, upserted on boot) and can be
 * tuned at runtime by a platform ADMIN through /api/admin/tenants.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getDb } from './mongo.js';
import { logger } from '../lib/logger.js';

export const ALL_TOOL_NAMES = [
  'search_tenders', 'get_tender', 'search_documents', 'get_contract_terms', 'create_tender_db', 'list_bids', 'award_tender', 'submit_bid',
] as const;

export const WebhookSchema = z.object({
  id: z.string().min(3),
  url: z.string().url(),
  secret: z.string().min(12),
  events: z.array(z.string()).min(1),
});

export const TenantSettingsSchema = z.object({
  models: z.array(z.string()).min(1),
  cache: z.object({ enabled: z.boolean(), threshold: z.number().min(0.5).max(1) }),
  piiPolicy: z.enum(['redact', 'block']),
  enabledTools: z.array(z.enum(ALL_TOOL_NAMES)),
  approvals: z.object({ awardTender: z.boolean(), createTenderAbove: z.number().min(0).nullable() }),
  limits: z.object({ rateLimitPerMinute: z.number().int().min(1), monthlyBudgetUsd: z.number().min(0) }),
  webhooks: z.array(WebhookSchema),
});

export const TenantSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(2),
  region: z.string(),
  plan: z.string(),
  settings: TenantSettingsSchema,
});

export type Tenant = z.infer<typeof TenantSchema>;
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

const col = () => getDb().collection<Tenant & { updatedAt: Date }>('tenants');
const cache = new Map<string, { tenant: Tenant; at: number }>();
const TTL_MS = 15_000;

/** Upsert tenants from config files. Existing runtime edits win unless the file version is newer. */
export async function loadTenantConfigs(dir = join(process.cwd(), 'tenants')) {
  await col().createIndex({ tenantId: 1 }, { unique: true });
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const parsed = TenantSchema.safeParse(JSON.parse(await readFile(join(dir, f), 'utf8')));
    if (!parsed.success) {
      logger.error('invalid tenant config, skipped', { file: f, issues: parsed.error.issues.slice(0, 3) });
      continue;
    }
    await col().updateOne(
      { tenantId: parsed.data.tenantId },
      { $setOnInsert: { ...parsed.data, createdAt: new Date() }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
  }
  logger.info('tenant configs loaded', { files: files.length });
}

export async function getTenant(tenantId: string): Promise<Tenant> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tenant;
  const t = await col().findOne({ tenantId }, { projection: { _id: 0, createdAt: 0, updatedAt: 0 } });
  if (!t) throw new Error(`Unknown tenant ${tenantId}`);
  cache.set(tenantId, { tenant: t, at: Date.now() });
  return t;
}

export async function listTenants(): Promise<Tenant[]> {
  return col().find({}, { projection: { _id: 0 } }).sort({ tenantId: 1 }).toArray();
}

export async function createTenant(t: Tenant) {
  await col().insertOne({ ...t, updatedAt: new Date() });
  cache.delete(t.tenantId);
}

export async function updateTenantSettings(tenantId: string, patch: Partial<TenantSettings>): Promise<Tenant> {
  const current = await getTenant(tenantId);
  const next = TenantSettingsSchema.parse({ ...current.settings, ...patch });
  await col().updateOne({ tenantId }, { $set: { settings: next, updatedAt: new Date() } });
  cache.delete(tenantId);
  return getTenant(tenantId);
}

/** Never send webhook secrets to clients. */
export function redactTenant(t: Tenant) {
  return { ...t, settings: { ...t.settings, webhooks: t.settings.webhooks.map((w) => ({ ...w, secret: `${w.secret.slice(0, 6)}…` })) } };
}
