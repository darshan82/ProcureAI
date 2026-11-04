/** Runs the graph for one turn (or a HITL resume) and returns answer + execution trace. */
import { Command } from '@langchain/langgraph';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { config } from '../config.js';
import { agentGraph } from './graph.js';
import type { UserContext } from './state.js';

export interface TraceStep {
  node: string;
  ms: number;
  detail?: string;
}

export interface PendingApproval {
  type: string;
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
}

export interface AgentResult {
  status: 'completed' | 'awaiting_approval';
  answer?: string;
  pending?: PendingApproval[];
  intent: string;
  toolsUsed: string[];
  piiRedactions: number;
  trace: TraceStep[];
  llmMode: string;
}

function describe(node: string, update: any): string | undefined {
  if (!update || typeof update !== 'object') return undefined;
  if (node === 'classify_intent') return `intent=${update.intent}`;
  if (node === 'supervisor') {
    const msg = update.messages?.[0];
    const calls = msg?.tool_calls?.map((c: any) => c.name) ?? [];
    return calls.length ? `tool_calls: ${calls.join(', ')}` : 'final answer';
  }
  if (node === 'execute_tools') return `ran: ${(update.toolsUsed ?? []).join(', ')}`;
  if (node === 'human_review') return `decision=${update.approval}`;
  if (node === '__interrupt__') return 'paused for human approval';
  return undefined;
}

export async function runAgent(opts: {
  threadKey: string;
  user: UserContext;
  message?: string;
  resume?: { approved: boolean; comment?: string; reviewer?: string };
}): Promise<AgentResult> {
  const runConfig = {
    configurable: { thread_id: opts.threadKey, user: opts.user },
    recursionLimit: 16,
    runName: opts.resume ? 'procure-agent.resume' : 'procure-agent',
    tags: ['procurement', opts.user.role.toLowerCase()],
    metadata: { userId: opts.user.sub, role: opts.user.role, threadKey: opts.threadKey }, // shows up in LangSmith
  };

  const before = await agentGraph.getState(runConfig);
  const prevTools = (before.values?.toolsUsed as string[] | undefined)?.length ?? 0;
  const prevPii = (before.values?.piiRedactions as number | undefined) ?? 0;

  const input = opts.resume
    ? new Command({ resume: opts.resume })
    : { messages: [new HumanMessage(opts.message!)], user: opts.user, approval: 'none' as const };

  const trace: TraceStep[] = [];
  let last = performance.now();
  const stream = await agentGraph.stream(input as any, { ...runConfig, streamMode: 'updates' });
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
      const now = performance.now();
      trace.push({ node, ms: Math.round(now - last), detail: describe(node, update) });
      last = now;
    }
  }

  const snap = await agentGraph.getState(runConfig);
  const values = snap.values as any;
  const base = {
    intent: values.intent,
    toolsUsed: (values.toolsUsed ?? []).slice(prevTools),
    piiRedactions: (values.piiRedactions ?? 0) - prevPii,
    trace,
    llmMode: config.llm.mode,
  };

  if (snap.next.length > 0) {
    const pending = snap.tasks.flatMap((t: any) => t.interrupts ?? []).map((i: any) => i.value as PendingApproval);
    return { status: 'awaiting_approval', pending, ...base };
  }
  const final = [...values.messages].reverse().find((m: unknown) => m instanceof AIMessage) as AIMessage | undefined;
  const answer = typeof final?.content === 'string' ? final.content : JSON.stringify(final?.content ?? '');
  return { status: 'completed', answer, ...base };
}

export async function hasPendingApproval(threadKey: string, user: UserContext): Promise<boolean> {
  const snap = await agentGraph.getState({ configurable: { thread_id: threadKey, user } });
  return snap.next.length > 0;
}
