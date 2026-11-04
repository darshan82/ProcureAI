/**
 * Supervisor agent graph:
 *
 *   START -> classify_intent -> supervisor --(no tool calls)--> END
 *                                  |  ^
 *              (sensitive tool) ---+  |---- execute_tools <--(safe tool)
 *                                  v  |
 *                             human_review  (interrupt() -> approve / reject)
 */
import { END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { config } from '../config.js';
import { scrubPii } from '../lib/pii.js';
import { AgentState, HITL_TOOLS, type AgentStateT } from './state.js';
import { classifyIntent } from './intent.js';
import { ALL_TOOLS, toolsForRole } from './tools.js';
import { systemPrompt } from './prompts.js';
import { mockSupervisor } from './mockLlm.js';

const chat =
  config.llm.mode === 'openai'
    ? new ChatOpenAI({ apiKey: config.llm.openaiKey, model: config.llm.model, temperature: 0, maxRetries: 2, timeout: 60_000 })
    : null;

/**
 * Redact PII from everything that is about to leave for the model provider. The whole history is
 * scrubbed on every call, but only content added since the last model turn is counted, so the
 * metric reflects new redactions instead of re-counting old ones.
 */
function scrubForEgress(messages: BaseMessage[]): { messages: BaseMessage[]; redactions: number } {
  let redactions = 0;
  let lastAiIndex = -1;
  messages.forEach((m, i) => { if (m instanceof AIMessage) lastAiIndex = i; });
  const out = messages.map((m, i) => {
    if (typeof m.content !== 'string') return m;
    const scrub = (text: string) => {
      const r = scrubPii(text);
      if (i > lastAiIndex) redactions += r.findings.reduce((n, f) => n + f.count, 0);
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
  const { messages, redactions } = scrubForEgress(state.messages);
  if (!chat) return { messages: [mockSupervisor(messages, state.user)], piiRedactions: redactions };
  const model = chat.bindTools(toolsForRole(state.user.role));
  const response = await model.invoke([new SystemMessage(systemPrompt(state.user)), ...messages], runConfig);
  return { messages: [response], piiRedactions: redactions };
}

function lastAi(state: AgentStateT): AIMessage | undefined {
  const last = state.messages[state.messages.length - 1];
  return last instanceof AIMessage ? last : undefined;
}

function routeAfterSupervisor(state: AgentStateT) {
  const calls = lastAi(state)?.tool_calls ?? [];
  if (!calls.length) return END;
  return calls.some((c) => HITL_TOOLS.has(c.name)) ? 'human_review' : 'execute_tools';
}

async function humanReviewNode(state: AgentStateT) {
  const ai = lastAi(state)!;
  const pending = (ai.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args }));
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
  const result = (await toolNode.invoke(state, runConfig)) as { messages: BaseMessage[] };
  return { messages: result.messages, toolsUsed: names, approval: 'none' as const };
}

export const checkpointer = new MemorySaver();

export const agentGraph = new StateGraph(AgentState)
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
