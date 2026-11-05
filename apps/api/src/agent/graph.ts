/**
 * Supervisor agent graph:
 *
 *   START -> classify_intent -> supervisor --(no tool calls)--> END
 *                                  |  ^
 *        (policy: needs approval) -+  |---- execute_tools <--(allowed tool)
 *                                  v  |
 *                             human_review  (interrupt() -> approve / reject)
 *
 * Approval policy is per tenant (e.g. awards always, tender creation above a budget).
 * State is checkpointed in MongoDB, so a paused approval survives restarts and any API replica can resume it.
 */
import { END, MemorySaver, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ToolCall } from '@langchain/core/messages/tool';
import { config } from '../config.js';
import { scrubPii } from '../lib/pii.js';
import { piiRedactions } from '../lib/metrics.js';
import { getMongoClient } from '../services/mongo.js';
import type { TenantSettings } from '../services/tenants.js';
import { AgentState, type AgentStateT } from './state.js';
import { classifyIntent } from './intent.js';
import { ALL_TOOLS, toolsFor } from './tools.js';
import { systemPrompt } from './prompts.js';
import { invokeWithGateway } from './llmGateway.js';

/** Returns a human-readable reason when a tool call needs approval under the tenant's policy. */
export function approvalReason(call: ToolCall, tenant: TenantSettings): string | null {
  if (call.name === 'award_tender' && tenant.approvals.awardTender) return 'Contract awards require buyer approval';
  if (call.name === 'create_tender_db' && tenant.approvals.createTenderAbove !== null) {
    const budget = Number(call.args?.budget ?? 0);
    if (budget > tenant.approvals.createTenderAbove) {
      return `Tender budget ${budget.toLocaleString('en-US')} exceeds the approval threshold of ${tenant.approvals.createTenderAbove.toLocaleString('en-US')}`;
    }
  }
  return null;
}

/**
 * Redact PII from everything that is about to leave for the model provider. The whole history is
 * scrubbed on every call, but only content added since the last model turn is counted.
 */
function scrubForEgress(messages: BaseMessage[], tenantId: string): { messages: BaseMessage[]; redactions: number } {
  let redactions = 0;
  let lastAiIndex = -1;
  messages.forEach((m, i) => { if (m instanceof AIMessage) lastAiIndex = i; });
  const out = messages.map((m, i) => {
    if (typeof m.content !== 'string') return m;
    const scrub = (text: string) => {
      const r = scrubPii(text);
      if (i > lastAiIndex) {
        for (const f of r.findings) {
          redactions += f.count;
          piiRedactions.inc({ tenant: tenantId, type: f.type }, f.count);
        }
      }
      return r.text;
    };
    if (m instanceof HumanMessage) return new HumanMessage({ content: scrub(m.content), id: m.id });
    if (m instanceof ToolMessage) return new ToolMessage({ content: scrub(m.content), tool_call_id: m.tool_call_id, name: m.name, id: m.id });
    return m;
  });
  return { messages: out, redactions };
}

async function classifyNode(state: AgentStateT) {
  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  return { intent: classifyIntent(String(lastHuman?.content ?? '')) };
}

async function supervisorNode(state: AgentStateT, runConfig?: RunnableConfig) {
  const { messages, redactions } = scrubForEgress(state.messages, state.user.tenantId);
  const r = await invokeWithGateway({
    tenantId: state.user.tenantId,
    modelChain: state.tenant.models,
    system: systemPrompt(state.user),
    messages,
    tools: toolsFor(state.user.role, state.tenant),
    user: state.user,
    runConfig,
  });
  return {
    messages: [r.message],
    piiRedactions: redactions,
    usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, llmCalls: 1, models: [r.model], fallbacks: r.fallbacks },
  };
}

function lastAi(state: AgentStateT): AIMessage | undefined {
  const last = state.messages[state.messages.length - 1];
  return last instanceof AIMessage ? last : undefined;
}

function routeAfterSupervisor(state: AgentStateT) {
  const calls = lastAi(state)?.tool_calls ?? [];
  if (!calls.length) return END;
  return calls.some((c) => approvalReason(c, state.tenant)) ? 'human_review' : 'execute_tools';
}

async function humanReviewNode(state: AgentStateT) {
  const ai = lastAi(state)!;
  const pending = (ai.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args, reason: approvalReason(c, state.tenant) }));
  // Pauses the graph; the checkpoint is persisted and resumed via POST /api/chat/resume.
  const decision = interrupt({ type: 'approval_required', toolCalls: pending }) as { approved: boolean; comment?: string; reviewer?: string };
  if (decision?.approved) return { approval: 'approved' as const };
  return {
    approval: 'rejected' as const,
    messages: pending.map((c) => new ToolMessage({
      tool_call_id: c.id!, name: c.name,
      content: `REJECTED: a human reviewer${decision?.reviewer ? ` (${decision.reviewer})` : ''} declined ${c.name}${decision?.comment ? ` - "${decision.comment}"` : ''}.`,
    })),
  };
}

const toolNode = new ToolNode(ALL_TOOLS, { handleToolErrors: true });

async function executeToolsNode(state: AgentStateT, runConfig?: RunnableConfig) {
  const names = (lastAi(state)?.tool_calls ?? []).map((c) => c.name);
  const cfg = { ...runConfig, configurable: { ...runConfig?.configurable, user: state.user, tenantSettings: state.tenant } };
  const result = (await toolNode.invoke(state, cfg)) as { messages: BaseMessage[] };
  return { messages: result.messages, toolsUsed: names, approval: 'none' as const };
}

function build(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(AgentState)
    .addNode('classify_intent', classifyNode)
    .addNode('supervisor', supervisorNode)
    .addNode('human_review', humanReviewNode)
    .addNode('execute_tools', executeToolsNode)
    .addEdge(START, 'classify_intent')
    .addEdge('classify_intent', 'supervisor')
    .addConditionalEdges('supervisor', routeAfterSupervisor, ['human_review', 'execute_tools', END])
    .addConditionalEdges('human_review', (s: AgentStateT) => (s.approval === 'approved' ? 'execute_tools' : 'supervisor'), ['execute_tools', 'supervisor'])
    .addEdge('execute_tools', 'supervisor')
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof build>;
let graph: AgentGraph | null = null;

/** Called once Mongo is connected. CHECKPOINTER=memory is available for tests / single-process dev. */
export function initGraph(): AgentGraph {
  const saver = process.env.CHECKPOINTER === 'memory'
    ? new MemorySaver()
    : new MongoDBSaver({ client: getMongoClient() as never, dbName: config.mongo.db, checkpointCollectionName: 'agent_checkpoints', checkpointWritesCollectionName: 'agent_checkpoint_writes' });
  graph = build(saver);
  return graph;
}

export function getGraph(): AgentGraph {
  if (!graph) throw new Error('Agent graph not initialised');
  return graph;
}
