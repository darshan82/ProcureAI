/**
 * Typed (Zod) tool bindings the agent can call. Three layers of authorization:
 *  1. only role- and tenant-enabled tools are bound to the model,
 *  2. each tool re-checks role + tenant enablement at execution time (defence in depth),
 *  3. every query is scoped to the caller's tenantId (row-level isolation).
 */
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { audit, bids, getDb, tenders, type Tender } from '../services/mongo.js';
import { searchChunks } from '../services/retriever.js';
import { publishEvent } from '../services/kafka.js';
import type { TenantSettings } from '../services/tenants.js';
import { toolCalls } from '../lib/metrics.js';
import { shortId } from '../lib/ids.js';
import type { Role, UserContext } from './state.js';

export const TOOL_ROLES: Record<string, Role[]> = {
  search_tenders: ['BUYER', 'SUPPLIER'],
  get_tender: ['BUYER', 'SUPPLIER'],
  search_documents: ['BUYER', 'SUPPLIER'],
  get_contract_terms: ['BUYER', 'SUPPLIER'],
  create_tender_db: ['BUYER'],
  list_bids: ['BUYER'],
  award_tender: ['BUYER'],
  submit_bid: ['SUPPLIER'],
};

function authorize(toolName: string, config: RunnableConfig | undefined): UserContext {
  const user = config?.configurable?.user as UserContext | undefined;
  const tenant = config?.configurable?.tenantSettings as TenantSettings | undefined;
  if (!user) throw new Error('No authenticated user in tool context');
  if (!TOOL_ROLES[toolName]?.includes(user.role)) throw new Error(`FORBIDDEN: role ${user.role} may not call ${toolName}`);
  if (tenant && !tenant.enabledTools.includes(toolName as never)) throw new Error(`FORBIDDEN: ${toolName} is disabled for tenant ${user.tenantId}`);
  toolCalls.inc({ tenant: user.tenantId, tool: toolName });
  return user;
}

const publicTender = (t: Tender) => ({
  tenderId: t.tenderId, title: t.title, category: t.category, description: t.description,
  budget: t.budget, currency: t.currency, deadline: t.deadline, status: t.status, criteria: t.criteria,
  awardedBidId: t.awardedBidId,
});

const TenderId = z.string().regex(/^TND-[A-Z0-9]+$/i);

export const searchTendersTool = tool(
  async ({ status, query, category }, config) => {
    const user = authorize('search_tenders', config);
    const filter: Record<string, unknown> = { tenantId: user.tenantId };
    if (status) filter.status = status;
    if (category) filter.category = { $regex: category, $options: 'i' };
    if (query) filter.$or = [{ title: { $regex: query, $options: 'i' } }, { description: { $regex: query, $options: 'i' } }];
    const rows = await tenders().find(filter).sort({ createdAt: -1 }).limit(20).toArray();
    return JSON.stringify({ count: rows.length, tenders: rows.map(publicTender) });
  },
  {
    name: 'search_tenders',
    description: 'Search procurement tenders by status, free-text query or category. Use for any question about tenders.',
    schema: z.object({
      status: z.enum(['OPEN', 'EVALUATION', 'AWARDED', 'CLOSED']).optional().describe('Filter by tender status'),
      query: z.string().optional().describe('Free-text match on title/description'),
      category: z.string().optional(),
    }),
  },
);

export const getTenderTool = tool(
  async ({ tenderId }, config) => {
    const user = authorize('get_tender', config);
    const t = await tenders().findOne({ tenantId: user.tenantId, tenderId: tenderId.toUpperCase() });
    return t ? JSON.stringify(publicTender(t)) : JSON.stringify({ error: `Tender ${tenderId} not found` });
  },
  {
    name: 'get_tender',
    description: 'Get full details (budget, deadline, evaluation criteria) of one tender by its ID, e.g. TND-1001.',
    schema: z.object({ tenderId: TenderId }),
  },
);

export const createTenderTool = tool(
  async (input, config) => {
    const user = authorize('create_tender_db', config);
    const doc: Tender = {
      tenantId: user.tenantId, tenderId: shortId('TND'), title: input.title, description: input.description,
      category: input.category, budget: input.budget, currency: input.currency, deadline: input.deadline,
      criteria: input.criteria, status: 'OPEN', createdBy: user.sub, createdAt: new Date(),
    };
    await tenders().insertOne(doc);
    await audit('tender.created', user, { tenderId: doc.tenderId, title: doc.title, budget: doc.budget });
    await publishEvent(user.tenantId, 'tender.created', publicTender(doc), user.sub);
    return JSON.stringify({ created: true, tender: publicTender(doc) });
  },
  {
    name: 'create_tender_db',
    description: 'BUYER only. Create and publish a new tender in the database. May require human approval above the tenant budget threshold.',
    schema: z.object({
      title: z.string().min(3).max(140),
      description: z.string().min(3).max(2000),
      category: z.string().default('General'),
      budget: z.number().positive().describe('Maximum budget amount'),
      currency: z.string().length(3).default('USD'),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Submission deadline YYYY-MM-DD'),
      criteria: z.array(z.string()).min(1).describe('Weighted evaluation criteria, e.g. "Price (40%)"'),
    }),
  },
);

export const submitBidTool = tool(
  async ({ tenderId, amount, proposal, deliveryDays }, config) => {
    const user = authorize('submit_bid', config);
    const t = await tenders().findOne({ tenantId: user.tenantId, tenderId: tenderId.toUpperCase() });
    if (!t) return JSON.stringify({ error: `Tender ${tenderId} not found` });
    if (t.status !== 'OPEN') return JSON.stringify({ error: `Tender ${t.tenderId} is ${t.status}, bids are closed` });
    const bid = { tenantId: user.tenantId, bidId: shortId('BID'), tenderId: t.tenderId, supplier: user.sub, amount, proposal, deliveryDays, status: 'SUBMITTED' as const, createdAt: new Date() };
    await bids().insertOne(bid);
    await audit('bid.submitted', user, { bidId: bid.bidId, tenderId: t.tenderId, amount });
    await publishEvent(user.tenantId, 'bid.submitted', { bidId: bid.bidId, tenderId: t.tenderId, amount, deliveryDays }, user.sub);
    return JSON.stringify({ submitted: true, bid: { bidId: bid.bidId, tenderId: bid.tenderId, amount, deliveryDays, status: bid.status }, withinBudget: amount <= t.budget });
  },
  {
    name: 'submit_bid',
    description: 'SUPPLIER only. Submit a bid (price + proposal) for an OPEN tender.',
    schema: z.object({
      tenderId: TenderId,
      amount: z.number().positive(),
      proposal: z.string().min(3).max(4000),
      deliveryDays: z.number().int().positive().default(30),
    }),
  },
);

export const listBidsTool = tool(
  async ({ tenderId }, config) => {
    const user = authorize('list_bids', config);
    const rows = await bids().find({ tenantId: user.tenantId, tenderId: tenderId.toUpperCase() }).sort({ amount: 1 }).toArray();
    return JSON.stringify({
      tenderId: tenderId.toUpperCase(),
      count: rows.length,
      bids: rows.map((b) => ({ bidId: b.bidId, supplier: b.supplier, amount: b.amount, deliveryDays: b.deliveryDays, proposal: b.proposal, status: b.status })),
    });
  },
  {
    name: 'list_bids',
    description: 'BUYER only. List and compare all bids received for a tender (sorted by price).',
    schema: z.object({ tenderId: TenderId }),
  },
);

export const awardTenderTool = tool(
  async ({ tenderId, bidId }, config) => {
    const user = authorize('award_tender', config);
    const scope = { tenantId: user.tenantId };
    const t = await tenders().findOne({ ...scope, tenderId: tenderId.toUpperCase() });
    const b = await bids().findOne({ ...scope, bidId: bidId.toUpperCase(), tenderId: tenderId.toUpperCase() });
    if (!t || !b) return JSON.stringify({ error: 'Tender or bid not found for this tender' });
    if (t.status === 'AWARDED') return JSON.stringify({ error: `${t.tenderId} was already awarded to ${t.awardedBidId}` });
    await tenders().updateOne({ ...scope, tenderId: t.tenderId }, { $set: { status: 'AWARDED', awardedBidId: b.bidId } });
    await bids().updateMany({ ...scope, tenderId: t.tenderId }, [{ $set: { status: { $cond: [{ $eq: ['$bidId', b.bidId] }, 'AWARDED', 'REJECTED'] } } }]);
    await audit('tender.awarded', user, { tenderId: t.tenderId, bidId: b.bidId, amount: b.amount, approvedVia: 'human-in-the-loop' });
    await publishEvent(user.tenantId, 'tender.awarded', { tenderId: t.tenderId, bidId: b.bidId, supplier: b.supplier, amount: b.amount, currency: t.currency }, user.sub);
    return JSON.stringify({ awarded: true, tenderId: t.tenderId, bidId: b.bidId, supplier: b.supplier, amount: b.amount });
  },
  {
    name: 'award_tender',
    description: 'BUYER only. Award a tender to a winning bid. Requires human approval before it executes.',
    schema: z.object({ tenderId: TenderId, bidId: z.string().regex(/^BID-[A-Z0-9]+$/i) }),
  },
);

export const searchDocumentsTool = tool(
  async ({ query, k }, config) => {
    const user = authorize('search_documents', config);
    const hits = await searchChunks(user.tenantId, query, k);
    if (!hits.length) return JSON.stringify({ count: 0, note: 'No ingested documents matched. Upload a contract/RFP PDF first.' });
    return JSON.stringify({ count: hits.length, passages: hits.map((h) => ({ source: `${h.filename}#chunk-${h.chunkIndex}`, score: h.score, text: h.text.replace(/\s+/g, ' ').trim().slice(0, 1200) })) });
  },
  {
    name: 'search_documents',
    description: 'Semantic search (RAG) over uploaded contracts, RFPs and proposals. Use for specific clauses and wording. Cite the returned sources.',
    schema: z.object({ query: z.string().min(2), k: z.number().int().min(1).max(8).default(4) }),
  },
);

export const getContractTermsTool = tool(
  async ({ documentId, filename }, config) => {
    const user = authorize('get_contract_terms', config);
    const filter: Record<string, unknown> = { tenantId: user.tenantId, status: 'READY', extraction: { $exists: true } };
    if (documentId) filter.documentId = documentId.toUpperCase();
    if (filename) filter.filename = { $regex: filename.replace(/[^\w.-]/g, ''), $options: 'i' };
    const doc = await getDb().collection('documents').find(filter, { projection: { _id: 0, documentId: 1, filename: 1, extraction: 1 } })
      .sort({ createdAt: -1 }).limit(1).next();
    if (!doc) return JSON.stringify({ error: 'No processed contract found. Upload a contract first.' });
    return JSON.stringify(doc);
  },
  {
    name: 'get_contract_terms',
    description: 'Return the structured, validated contract summary (parties, value, delivery, payment, warranty, SLA, penalties, termination, evaluation criteria, risk flags) extracted at ingestion. Best for "summarise the contract" and risk questions. Defaults to the latest contract.',
    schema: z.object({ documentId: z.string().optional(), filename: z.string().optional() }),
  },
);

export const ALL_TOOLS = [
  searchTendersTool, getTenderTool, searchDocumentsTool, getContractTermsTool, createTenderTool, listBidsTool, awardTenderTool, submitBidTool,
];

export function toolsFor(role: Role, tenant: TenantSettings) {
  return ALL_TOOLS.filter((t) => TOOL_ROLES[t.name]?.includes(role) && tenant.enabledTools.includes(t.name as never));
}
