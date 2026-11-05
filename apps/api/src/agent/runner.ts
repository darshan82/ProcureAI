/**
 * Runs the graph for one turn (or a HITL resume) as an async stream of events:
 *   step  - a graph node finished (with timing + detail)        -> live trace in the UI
 *   token - an LLM token from the supervisor (OpenAI mode)       -> typing effect
 *   result - final answer or pending approval, usage, trace
 * runAgent() consumes the same stream for the plain JSON endpoint.
 */
import { Command } from '@langchain/langgraph';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { config } from '../config.js';
import { agentRunDuration, hitlDecisions } from '../lib/metrics.js';
import type { TenantSettings } from '../services/tenants.js';
import { getGraph } from './graph.js';
import type { RunUsage, UserContext } from './state.js';

export interface TraceStep { node: string; ms: number; detail?: string }

export interface PendingApproval {
  type: string;
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown>; reason?: string | null }>;
}

export interface AgentResult {
  status: 'completed' | 'awaiting_approval';
  answer?: string;
  pending?: PendingApproval[];
  intent: string;
  toolsUsed: string[];
  piiRedactions: number;
  usage: RunUsage;
  trace: TraceStep[];
  llmMode: string;
}

export type AgentEvent =
  | { type: 'step'; step: TraceStep }
  | { type: 'token'; text: string }
  | { type: 'result'; result: AgentResult };

function describe(node: string, update: any): string | undefined {
  if (!update || typeof update !== 'object') return undefined;
  if (node === 'classify_intent') return `intent=${update.intent}`;
  if (node === 'supervisor') {
    const msg = update.messages?.[0];
    const calls = msg?.tool_calls?.map((c: any) => c.name) ?? [];
    const model = update.usage?.models?.[0];
    const fb = update.usage?.fallbacks?.length ? ` (fallbacks: ${update.usage.fallbacks.join(', ')})` : '';
    return `${model ?? ''} → ${calls.length ? `tool_calls: ${calls.join(', ')}` : 'final answer'}${fb}`;
  }
  if (node === 'execute_tools') return `ran: ${(update.toolsUsed ?? []).join(', ')}`;
  if (node === 'human_review') return `decision=${update.approval}`;
  if (node === '__interrupt__') return 'paused for human approval';
  return undefined;
}

const zeroUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0, models: [], fallbacks: [] });

function diffUsage(before: RunUsage | undefined, after: RunUsage | undefined): RunUsage {
  const b = before ?? zeroUsage();
  const a = after ?? zeroUsage();
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    costUsd: Math.round((a.costUsd - b.costUsd) * 1e6) / 1e6,
    llmCalls: a.llmCalls - b.llmCalls,
    models: a.models.slice(b.models.length),
    fallbacks: a.fallbacks.slice(b.fallbacks.length),
  };
}

export async function* streamAgent(opts: {
  threadKey: string;
  user: UserContext;
  tenant: TenantSettings;
  message?: string;
  resume?: { approved: boolean; comment?: string; reviewer?: string };
}): AsyncGenerator<AgentEvent> {
  const graph = getGraph();
  const runConfig = {
    configurable: { thread_id: opts.threadKey, user: opts.user, tenantSettings: opts.tenant },
    recursionLimit: 16,
    runName: opts.resume ? 'procure-agent.resume' : 'procure-agent',
    tags: ['procurement', `tenant:${opts.user.tenantId}`, opts.user.role.toLowerCase()],
    metadata: { userId: opts.user.sub, role: opts.user.role, tenantId: opts.user.tenantId, threadKey: opts.threadKey }, // LangSmith filters
  };
  const started = performance.now();

  const before = await graph.getState(runConfig);
  const prev = before.values as any;
  const prevTools = (prev?.toolsUsed as string[] | undefined)?.length ?? 0;
  const prevPii = (prev?.piiRedactions as number | undefined) ?? 0;

  if (opts.resume) hitlDecisions.inc({ tenant: opts.user.tenantId, decision: opts.resume.approved ? 'approved' : 'rejected' });
  const input = opts.resume
    ? new Command({ resume: opts.resume })
    : { messages: [new HumanMessage(opts.message!)], user: opts.user, tenant: opts.tenant, approval: 'none' as const };

  const trace: TraceStep[] = [];
  let last = performance.now();
  const stream = await graph.stream(input as any, { ...runConfig, streamMode: ['updates', 'messages'] as const });
  for await (const [mode, chunk] of stream as AsyncIterable<[string, any]>) {
    if (mode === 'messages') {
      const [msg, meta] = chunk as [AIMessageChunk, { langgraph_node?: string }];
      // Only provider token chunks count as tokens; whole messages (e.g. the offline mock) are replayed by the SSE route.
      if (meta?.langgraph_node === 'supervisor' && msg instanceof AIMessageChunk && typeof msg.content === 'string' && msg.content) yield { type: 'token', text: msg.content };
      continue;
    }
    for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
      const now = performance.now();
      const step = { node, ms: Math.round(now - last), detail: describe(node, update) };
      trace.push(step);
      last = now;
      yield { type: 'step', step };
    }
  }

  const snap = await graph.getState(runConfig);
  const values = snap.values as any;
  const base = {
    intent: values.intent,
    toolsUsed: (values.toolsUsed ?? []).slice(prevTools),
    piiRedactions: (values.piiRedactions ?? 0) - prevPii,
    usage: diffUsage(prev?.usage, values.usage),
    trace,
    llmMode: config.llm.mode,
  };

  let result: AgentResult;
  if (snap.next.length > 0) {
    const pending = snap.tasks.flatMap((t: any) => t.interrupts ?? []).map((i: any) => i.value as PendingApproval);
    result = { status: 'awaiting_approval', pending, ...base };
  } else {
    const final = [...values.messages].reverse().find((m: unknown) => m instanceof AIMessage) as AIMessage | undefined;
    const answer = typeof final?.content === 'string' ? final.content : JSON.stringify(final?.content ?? '');
    result = { status: 'completed', answer, ...base };
  }
  agentRunDuration.observe({ tenant: opts.user.tenantId, intent: String(base.intent), status: result.status }, (performance.now() - started) / 1000);
  yield { type: 'result', result };
}

export async function runAgent(opts: Parameters<typeof streamAgent>[0]): Promise<AgentResult> {
  for await (const ev of streamAgent(opts)) if (ev.type === 'result') return ev.result;
  throw new Error('Agent produced no result');
}

export async function hasPendingApproval(threadKey: string, user: UserContext): Promise<boolean> {
  const snap = await getGraph().getState({ configurable: { thread_id: threadKey, user } });
  return snap.next.length > 0;
}
