/**
 * Typed (Zod) tool bindings the agent can call. RBAC is enforced *inside* each tool
 * (defence in depth) in addition to only binding role-appropriate tools to the model.
 */
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { audit, bids, tenders, type Tender } from '../services/mongo.js';
import { searchChunks } from '../services/retriever.js';
import { shortId } from '../lib/ids.js';
import type { Role, UserContext } from './state.js';

const TOOL_ROLES: Record<string, Role[]> = {
  search_tenders: ['BUYER', 'SUPPLIER'],
  get_tender: ['BUYER', 'SUPPLIER'],
  search_documents: ['BUYER', 'SUPPLIER'],
  create_tender_db: ['BUYER'],
  list_bids: ['BUYER'],
  award_tender: ['BUYER'],
  submit_bid: ['SUPPLIER'],
};

function userFrom(config: RunnableConfig | undefined): UserContext {
  const user = config?.configurable?.user as UserContext | undefined;
  if (!user) throw new Error('No authenticated user in tool context');
  return user;
}

function authorize(toolName: string, config: RunnableConfig | undefined): UserContext {
  const user = userFrom(config);
  if (!TOOL_ROLES[toolName]?.includes(user.role)) {
    throw new Error(`FORBIDDEN: role ${user.role} may not call ${toolName}`);
  }
  return user;
}

const publicTender = (t: Tender) => ({
  tenderId: t.tenderId, title: t.title, category: t.category, description: t.description,
  budget: t.budget, currency: t.currency, deadline: t.deadline, status: t.status, criteria: t.criteria,
  awardedBidId: t.awardedBidId,
});

export const searchTendersTool = tool(
  async ({ status, query, category }, config) => {
    authorize('search_tenders', config);
    const filter: Record<string, unknown> = {};
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
    authorize('get_tender', config);
    const t = await tenders().findOne({ tenderId: tenderId.toUpperCase() });
    return t ? JSON.stringify(publicTender(t)) : JSON.stringify({ error: `Tender ${tenderId} not found` });
  },
  {
    name: 'get_tender',
    description: 'Get full details (budget, deadline, evaluation criteria) of one tender by its ID, e.g. TND-1001.',
    schema: z.object({ tenderId: z.string().regex(/^TND-[A-Z0-9]+$/i) }),
  },
);

export const createTenderTool = tool(
  async (input, config) => {
    const user = authorize('create_tender_db', config);
    const doc: Tender = {
      tenderId: shortId('TND'),
      title: input.title,
      description: input.description,
      category: input.category,
      budget: input.budget,
      currency: input.currency,
      deadline: input.deadline,
      criteria: input.criteria,
      status: 'OPEN',
      createdBy: user.sub,
      createdAt: new Date(),
    };
    await tenders().insertOne(doc);
    await audit('tender.created', user, { tenderId: doc.tenderId, title: doc.title });
    return JSON.stringify({ created: true, tender: publicTender(doc) });
  },
  {
    name: 'create_tender_db',
    description: 'BUYER only. Create and publish a new tender in the database.',
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
    const t = await tenders().findOne({ tenderId: tenderId.toUpperCase() });
    if (!t) return JSON.stringify({ error: `Tender ${tenderId} not found` });
    if (t.status !== 'OPEN') return JSON.stringify({ error: `Tender ${t.tenderId} is ${t.status}, bids are closed` });
    const bid = { bidId: shortId('BID'), tenderId: t.tenderId, supplier: user.sub, amount, proposal, deliveryDays, status: 'SUBMITTED' as const, createdAt: new Date() };
    await bids().insertOne(bid);
    await audit('bid.submitted', user, { bidId: bid.bidId, tenderId: t.tenderId, amount });
    return JSON.stringify({ submitted: true, bid: { ...bid, createdAt: undefined }, withinBudget: amount <= t.budget });
  },
  {
    name: 'submit_bid',
    description: 'SUPPLIER only. Submit a bid (price + proposal) for an OPEN tender.',
    schema: z.object({
      tenderId: z.string().regex(/^TND-[A-Z0-9]+$/i),
      amount: z.number().positive(),
      proposal: z.string().min(3).max(4000),
      deliveryDays: z.number().int().positive().default(30),
    }),
  },
);

export const listBidsTool = tool(
  async ({ tenderId }, config) => {
    authorize('list_bids', config);
    const rows = await bids().find({ tenderId: tenderId.toUpperCase() }).sort({ amount: 1 }).toArray();
    return JSON.stringify({
      tenderId: tenderId.toUpperCase(),
      count: rows.length,
      bids: rows.map((b) => ({ bidId: b.bidId, supplier: b.supplier, amount: b.amount, deliveryDays: b.deliveryDays, proposal: b.proposal, status: b.status })),
    });
  },
  {
    name: 'list_bids',
    description: 'BUYER only. List and compare all bids received for a tender (sorted by price).',
    schema: z.object({ tenderId: z.string().regex(/^TND-[A-Z0-9]+$/i) }),
  },
);

export const awardTenderTool = tool(
  async ({ tenderId, bidId }, config) => {
    const user = authorize('award_tender', config);
    const t = await tenders().findOne({ tenderId: tenderId.toUpperCase() });
    const b = await bids().findOne({ bidId: bidId.toUpperCase(), tenderId: tenderId.toUpperCase() });
    if (!t || !b) return JSON.stringify({ error: 'Tender or bid not found for this tender' });
    if (t.status === 'AWARDED') return JSON.stringify({ error: `${t.tenderId} was already awarded to ${t.awardedBidId}` });
    await tenders().updateOne({ tenderId: t.tenderId }, { $set: { status: 'AWARDED', awardedBidId: b.bidId } });
    await bids().updateMany({ tenderId: t.tenderId }, [{ $set: { status: { $cond: [{ $eq: ['$bidId', b.bidId] }, 'AWARDED', 'REJECTED'] } } }]);
    await audit('tender.awarded', user, { tenderId: t.tenderId, bidId: b.bidId, amount: b.amount, approvedVia: 'human-in-the-loop' });
    return JSON.stringify({ awarded: true, tenderId: t.tenderId, bidId: b.bidId, supplier: b.supplier, amount: b.amount });
  },
  {
    name: 'award_tender',
    description: 'BUYER only. Award a tender to a winning bid. Requires human approval before it executes.',
    schema: z.object({ tenderId: z.string().regex(/^TND-[A-Z0-9]+$/i), bidId: z.string().regex(/^BID-[A-Z0-9]+$/i) }),
  },
);

export const searchDocumentsTool = tool(
  async ({ query, k }, config) => {
    authorize('search_documents', config);
    const hits = await searchChunks(query, k);
    if (!hits.length) return JSON.stringify({ count: 0, note: 'No ingested documents matched. Upload a contract/RFP PDF first.' });
    return JSON.stringify({ count: hits.length, passages: hits.map((h) => ({ source: `${h.filename}#chunk-${h.chunkIndex}`, score: h.score, text: h.text.replace(/\s+/g, ' ').trim().slice(0, 1200) })) });
  },
  {
    name: 'search_documents',
    description: 'Semantic search (RAG) over uploaded contracts, RFPs and proposals. Use for contract summaries, clauses, criteria and terms. Cite the returned sources.',
    schema: z.object({ query: z.string().min(2), k: z.number().int().min(1).max(8).default(4) }),
  },
);

export const ALL_TOOLS = [
  searchTendersTool, getTenderTool, searchDocumentsTool, createTenderTool, listBidsTool, awardTenderTool, submitBidTool,
];

export function toolsForRole(role: Role) {
  return ALL_TOOLS.filter((t) => TOOL_ROLES[t.name]?.includes(role));
}
