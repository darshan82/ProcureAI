import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/** Every business document carries tenantId; every query filters on it (row-level tenant isolation). */
export interface Tender {
  tenantId: string;
  tenderId: string;
  title: string;
  description: string;
  category: string;
  budget: number;
  currency: string;
  deadline: string;
  criteria: string[];
  status: 'OPEN' | 'EVALUATION' | 'AWARDED' | 'CLOSED';
  createdBy: string;
  awardedBidId?: string;
  createdAt: Date;
}

export interface Bid {
  tenantId: string;
  bidId: string;
  tenderId: string;
  supplier: string;
  amount: number;
  proposal: string;
  deliveryDays: number;
  status: 'SUBMITTED' | 'AWARDED' | 'REJECTED';
  createdAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(config.mongo.url, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  db = client.db(config.mongo.db);
  await migrate(db);
  await Promise.all([
    db.collection('tenders').createIndex({ tenantId: 1, tenderId: 1 }, { unique: true }),
    db.collection('tenders').createIndex({ tenantId: 1, status: 1 }),
    db.collection('bids').createIndex({ tenantId: 1, bidId: 1 }, { unique: true }),
    db.collection('bids').createIndex({ tenantId: 1, tenderId: 1 }),
    db.collection('documents').createIndex({ documentId: 1 }, { unique: true }),
    db.collection('documents').createIndex({ tenantId: 1, createdAt: -1 }),
    db.collection('ingestion_jobs').createIndex({ jobId: 1 }, { unique: true }),
    db.collection('chunks').createIndex({ tenantId: 1, embeddingModel: 1 }),
    db.collection('chunks').createIndex({ documentId: 1 }),
    db.collection('audit_log').createIndex({ tenantId: 1, at: -1 }),
    db.collection('webhook_deliveries').createIndex({ tenantId: 1, createdAt: -1 }),
    db.collection('webhook_receipts').createIndex({ tenantId: 1, receivedAt: -1 }),
  ]);
  logger.info('mongo connected', { db: config.mongo.db });
  return db;
}

/**
 * Idempotent, versioned schema migrations (tracked in `migrations`).
 * v2: single-tenant -> multi-tenant. Backfills tenantId on existing data and drops the
 * old globally-unique indexes that would block the same IDs existing in different tenants.
 */
async function migrate(d: Db) {
  const done = new Set((await d.collection('migrations').find({}).toArray()).map((m) => m.id));
  if (!done.has('2026-11-v2-multitenancy')) {
    const legacyTenant = process.env.LEGACY_TENANT_ID ?? 'acme';
    const collections = ['tenders', 'bids', 'documents', 'ingestion_jobs', 'chunks', 'audit_log'];
    const backfilled: Record<string, number> = {};
    for (const c of collections) {
      const r = await d.collection(c).updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: legacyTenant } });
      backfilled[c] = r.modifiedCount;
    }
    for (const [c, idx] of [['tenders', 'tenderId_1'], ['bids', 'bidId_1'], ['tenders', 'status_1_category_1'], ['bids', 'tenderId_1'], ['chunks', 'embeddingModel_1']] as const) {
      await d.collection(c).dropIndex(idx).catch(() => undefined); // absent on fresh installs
    }
    await d.collection('migrations').insertOne({ id: '2026-11-v2-multitenancy', appliedAt: new Date(), backfilled });
    logger.info('migration applied', { id: '2026-11-v2-multitenancy', backfilled });
  }
}

export function getDb(): Db {
  if (!db) throw new Error('Mongo not connected');
  return db;
}

export function getMongoClient(): MongoClient {
  if (!client) throw new Error('Mongo not connected');
  return client;
}

export const tenders = () => getDb().collection<Tender>('tenders');
export const bids = () => getDb().collection<Bid>('bids');

export async function audit(event: string, actor: { sub: string; role: string; tenantId: string }, data: Record<string, unknown>) {
  await getDb().collection('audit_log').insertOne({ tenantId: actor.tenantId, event, actor: actor.sub, role: actor.role, data, at: new Date() });
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

export async function seedTenders() {
  const now = new Date();
  if ((await tenders().countDocuments({ tenantId: 'acme' })) === 0) {
    await tenders().insertMany([
      { tenantId: 'acme', tenderId: 'TND-1001', title: 'Laptops for engineering team', category: 'IT Hardware',
        description: '120 developer laptops (32GB RAM, 1TB SSD) with 3-year on-site warranty.',
        budget: 180000, currency: 'USD', deadline: inDays(14), status: 'OPEN', createdBy: 'buyer@acme.test',
        criteria: ['Price (40%)', 'Warranty & support SLA (30%)', 'Delivery time (20%)', 'Sustainability (10%)'], createdAt: now },
      { tenantId: 'acme', tenderId: 'TND-1002', title: 'Office cleaning services 2027', category: 'Facilities',
        description: 'Daily cleaning for 3 office floors, 12-month contract with monthly KPIs.',
        budget: 96000, currency: 'USD', deadline: inDays(21), status: 'OPEN', createdBy: 'buyer@acme.test',
        criteria: ['Price (50%)', 'References (25%)', 'Eco-friendly products (25%)'], createdAt: now },
      { tenantId: 'acme', tenderId: 'TND-1003', title: 'Cloud cost optimisation consulting', category: 'Professional Services',
        description: 'FinOps assessment of AWS spend and a 90-day savings roadmap.',
        budget: 45000, currency: 'USD', deadline: inDays(7), status: 'EVALUATION', createdBy: 'buyer@acme.test',
        criteria: ['Methodology (40%)', 'Team experience (35%)', 'Price (25%)'], createdAt: now },
    ]);
    await bids().insertMany([
      { tenantId: 'acme', bidId: 'BID-A1B2C3', tenderId: 'TND-1003', supplier: 'supplier@globex.test', amount: 39500, deliveryDays: 60,
        proposal: 'Certified FinOps practitioners, weekly savings reports, fixed fee.', status: 'SUBMITTED', createdAt: now },
      { tenantId: 'acme', bidId: 'BID-D4E5F6', tenderId: 'TND-1003', supplier: 'supplier@initech.test', amount: 43000, deliveryDays: 45,
        proposal: 'Automated tagging audit plus reserved-instance planning.', status: 'SUBMITTED', createdAt: now },
    ]);
  }
  if ((await tenders().countDocuments({ tenantId: 'umbrella' })) === 0) {
    await tenders().insertMany([
      { tenantId: 'umbrella', tenderId: 'TND-2001', title: 'MRI scanner maintenance contract', category: 'Medical Equipment',
        description: '3-year preventive and corrective maintenance for 4 MRI scanners, 98% uptime SLA.',
        budget: 750000, currency: 'USD', deadline: inDays(30), status: 'OPEN', createdBy: 'buyer@umbrella.test',
        criteria: ['Uptime SLA (40%)', 'Price (30%)', 'Certified engineers on site (30%)'], createdAt: now },
      { tenantId: 'umbrella', tenderId: 'TND-2002', title: 'Nitrile examination gloves', category: 'Consumables',
        description: '2 million boxes per year, EN 455 certified, monthly deliveries to 6 hospitals.',
        budget: 320000, currency: 'USD', deadline: inDays(10), status: 'EVALUATION', createdBy: 'buyer@umbrella.test',
        criteria: ['Price (50%)', 'Certification (30%)', 'Supply resilience (20%)'], createdAt: now },
    ]);
    await bids().insertMany([
      { tenantId: 'umbrella', bidId: 'BID-U1U2U3', tenderId: 'TND-2002', supplier: 'supplier@stark.test', amount: 298000, deliveryDays: 14,
        proposal: 'EN 455 certified, dual-source manufacturing, 4-week safety stock.', status: 'SUBMITTED', createdAt: now },
    ]);
  }
  logger.info('demo tenants seeded');
}

export async function closeMongo() {
  await client?.close();
}
