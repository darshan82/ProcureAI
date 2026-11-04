import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export interface Tender {
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
  await Promise.all([
    db.collection('tenders').createIndex({ tenderId: 1 }, { unique: true }),
    db.collection('tenders').createIndex({ status: 1, category: 1 }),
    db.collection('bids').createIndex({ bidId: 1 }, { unique: true }),
    db.collection('bids').createIndex({ tenderId: 1 }),
    db.collection('documents').createIndex({ documentId: 1 }, { unique: true }),
    db.collection('ingestion_jobs').createIndex({ jobId: 1 }, { unique: true }),
    db.collection('chunks').createIndex({ documentId: 1 }),
    db.collection('chunks').createIndex({ embeddingModel: 1 }),
    db.collection('audit_log').createIndex({ at: -1 }),
  ]);
  logger.info('mongo connected', { db: config.mongo.db });
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Mongo not connected');
  return db;
}

export const tenders = () => getDb().collection<Tender>('tenders');
export const bids = () => getDb().collection<Bid>('bids');

export async function audit(event: string, actor: { sub: string; role: string }, data: Record<string, unknown>) {
  await getDb().collection('audit_log').insertOne({ event, actor: actor.sub, role: actor.role, data, at: new Date() });
}

export async function seedTenders() {
  const col = tenders();
  if ((await col.estimatedDocumentCount()) > 0) return;
  const now = new Date();
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  await col.insertMany([
    {
      tenderId: 'TND-1001', title: 'Laptops for engineering team', category: 'IT Hardware',
      description: '120 developer laptops (32GB RAM, 1TB SSD) with 3-year on-site warranty.',
      budget: 180000, currency: 'USD', deadline: inDays(14), status: 'OPEN', createdBy: 'buyer@acme.test',
      criteria: ['Price (40%)', 'Warranty & support SLA (30%)', 'Delivery time (20%)', 'Sustainability (10%)'], createdAt: now,
    },
    {
      tenderId: 'TND-1002', title: 'Office cleaning services 2027', category: 'Facilities',
      description: 'Daily cleaning for 3 office floors, 12-month contract with monthly KPIs.',
      budget: 96000, currency: 'USD', deadline: inDays(21), status: 'OPEN', createdBy: 'buyer@acme.test',
      criteria: ['Price (50%)', 'References (25%)', 'Eco-friendly products (25%)'], createdAt: now,
    },
    {
      tenderId: 'TND-1003', title: 'Cloud cost optimisation consulting', category: 'Professional Services',
      description: 'FinOps assessment of AWS spend and a 90-day savings roadmap.',
      budget: 45000, currency: 'USD', deadline: inDays(7), status: 'EVALUATION', createdBy: 'buyer@acme.test',
      criteria: ['Methodology (40%)', 'Team experience (35%)', 'Price (25%)'], createdAt: now,
    },
  ]);
  await bids().insertMany([
    { bidId: 'BID-A1B2C3', tenderId: 'TND-1003', supplier: 'supplier@globex.test', amount: 39500, deliveryDays: 60,
      proposal: 'Certified FinOps practitioners, weekly savings reports, fixed fee.', status: 'SUBMITTED', createdAt: now },
    { bidId: 'BID-D4E5F6', tenderId: 'TND-1003', supplier: 'supplier@initech.test', amount: 43000, deliveryDays: 45,
      proposal: 'Automated tagging audit plus reserved-instance planning.', status: 'SUBMITTED', createdAt: now },
  ]);
  logger.info('seeded demo tenders and bids');
}

export async function closeMongo() {
  await client?.close();
}
