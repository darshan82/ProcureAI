/**
 * LangGraph state schema. `messages` uses the built-in append/merge reducer;
 * the rest are channels the graph nodes read and write.
 */
import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

export type Role = 'BUYER' | 'SUPPLIER';

export interface UserContext {
  sub: string; // email
  name: string;
  role: Role;
}

export type Intent = 'tender_query' | 'tender_mutation' | 'bid_action' | 'document_qa' | 'general';

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  user: Annotation<UserContext>(),
  intent: Annotation<Intent>({ reducer: (_prev, next) => next, default: () => 'general' }),
  /** Every tool name executed during this run (used to decide cacheability + cache invalidation). */
  toolsUsed: Annotation<string[]>({ reducer: (prev, next) => prev.concat(next), default: () => [] }),
  /** Human-in-the-loop decision for the pending sensitive tool call(s). */
  approval: Annotation<'none' | 'approved' | 'rejected'>({ reducer: (_p, n) => n, default: () => 'none' }),
  /** Number of PII entities redacted before LLM egress during this run. */
  piiRedactions: Annotation<number>({ reducer: (p, n) => p + n, default: () => 0 }),
});

export type AgentStateT = typeof AgentState.State;

/** Tools that change data. Their use makes the answer non-cacheable and invalidates the cache. */
export const MUTATING_TOOLS = new Set(['create_tender_db', 'submit_bid', 'award_tender']);
/** Tools that pause the graph for explicit human approval before executing. */
export const HITL_TOOLS = new Set(['award_tender']);
