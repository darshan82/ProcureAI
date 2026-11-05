/**
 * LangGraph state schema. `messages` uses the built-in append/merge reducer;
 * the rest are channels the graph nodes read and write.
 */
import { Annotation, MessagesAnnotation } from '@langchain/langgraph';
import type { TenantSettings } from '../services/tenants.js';

export type Role = 'BUYER' | 'SUPPLIER' | 'ADMIN';

export interface UserContext {
  sub: string; // email
  name: string;
  role: Role;
  tenantId: string;
}

export type Intent = 'tender_query' | 'tender_mutation' | 'bid_action' | 'document_qa' | 'general';

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  llmCalls: number;
  models: string[];
  fallbacks: string[];
}

const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0, models: [], fallbacks: [] });

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  user: Annotation<UserContext>(),
  /** Snapshot of the tenant's settings for this run (model chain, enabled tools, approval policy, PII policy). */
  tenant: Annotation<TenantSettings>(),
  intent: Annotation<Intent>({ reducer: (_prev, next) => next, default: () => 'general' }),
  /** Every tool name executed in this thread (used to decide cacheability + cache invalidation). */
  toolsUsed: Annotation<string[]>({ reducer: (prev, next) => prev.concat(next), default: () => [] }),
  /** Human-in-the-loop decision for the pending sensitive tool call(s). */
  approval: Annotation<'none' | 'approved' | 'rejected'>({ reducer: (_p, n) => n, default: () => 'none' }),
  /** Number of PII entities redacted before LLM egress. */
  piiRedactions: Annotation<number>({ reducer: (p, n) => p + n, default: () => 0 }),
  /** Token / cost accounting across all LLM calls in the thread. */
  usage: Annotation<RunUsage>({
    reducer: (p, n) => ({
      inputTokens: p.inputTokens + n.inputTokens,
      outputTokens: p.outputTokens + n.outputTokens,
      costUsd: p.costUsd + n.costUsd,
      llmCalls: p.llmCalls + n.llmCalls,
      models: p.models.concat(n.models),
      fallbacks: p.fallbacks.concat(n.fallbacks),
    }),
    default: emptyUsage,
  }),
});

export type AgentStateT = typeof AgentState.State;

/** Tools that change data. Their use makes the answer non-cacheable and invalidates the cache. */
export const MUTATING_TOOLS = new Set(['create_tender_db', 'submit_bid', 'award_tender']);
