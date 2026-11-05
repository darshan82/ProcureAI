/**
 * LLM gateway: the single place the agent talks to model providers.
 *  - Ordered model fallback chain per tenant (e.g. gpt-4o-mini -> gpt-4.1-mini).
 *  - Per-model circuit breaker (opens after N consecutive failures, half-opens after a cool-down).
 *  - Degraded mode: if every model is unavailable (or no key is configured) the deterministic
 *    mock model answers so the product keeps working.
 *  - Token + cost metering per tenant via usage_metadata.
 */
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { circuitState, llmFallbacks, llmLatency, llmRequests } from '../lib/metrics.js';
import { recordUsage } from '../services/usage.js';
import { mockSupervisor } from './mockLlm.js';
import type { UserContext } from './state.js';

const FAILURE_THRESHOLD = Number(process.env.LLM_CIRCUIT_FAILURES ?? 3);
const COOL_DOWN_MS = Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? 30_000);

interface Breaker { failures: number; openedAt: number | null }
const breakers = new Map<string, Breaker>();
const models = new Map<string, ChatOpenAI>();

function breaker(model: string): Breaker {
  if (!breakers.has(model)) breakers.set(model, { failures: 0, openedAt: null });
  return breakers.get(model)!;
}

function isOpen(model: string): boolean {
  const b = breaker(model);
  if (b.openedAt === null) return false;
  if (Date.now() - b.openedAt > COOL_DOWN_MS) return false; // half-open: allow one trial request
  return true;
}

function onSuccess(model: string) {
  breakers.set(model, { failures: 0, openedAt: null });
  circuitState.set({ model }, 0);
}

function onFailure(model: string) {
  const b = breaker(model);
  b.failures += 1;
  if (b.failures >= FAILURE_THRESHOLD) {
    b.openedAt = Date.now();
    circuitState.set({ model }, 1);
    logger.warn('llm circuit opened', { model, failures: b.failures });
  }
}

function chatModel(name: string): ChatOpenAI {
  if (!models.has(name)) {
    models.set(name, new ChatOpenAI({
      apiKey: config.llm.openaiKey, model: name, temperature: 0, maxRetries: 1, timeout: Number(process.env.LLM_TIMEOUT_MS ?? 45_000),
      streamUsage: true,
    }));
  }
  return models.get(name)!;
}

export interface GatewayResult {
  message: AIMessage;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  fallbacks: string[];
  degraded: boolean;
}

const estimateTokens = (msgs: BaseMessage[]) => Math.ceil(msgs.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);

export function circuitSnapshot() {
  return [...breakers.entries()].map(([model, b]) => ({ model, failures: b.failures, open: isOpen(model) }));
}

export async function invokeWithGateway(opts: {
  tenantId: string;
  modelChain: string[];
  system: string;
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
  user: UserContext;
  runConfig?: RunnableConfig;
}): Promise<GatewayResult> {
  const fallbacks: string[] = [];

  if (config.llm.mode === 'openai') {
    for (const [i, name] of opts.modelChain.entries()) {
      if (isOpen(name)) {
        llmRequests.inc({ tenant: opts.tenantId, model: name, outcome: 'circuit_open' });
        fallbacks.push(`${name}:circuit_open`);
        continue;
      }
      const end = llmLatency.startTimer({ model: name });
      try {
        const bound = opts.tools.length ? chatModel(name).bindTools(opts.tools) : chatModel(name);
        const msg = (await bound.invoke([new SystemMessage(opts.system), ...opts.messages], opts.runConfig)) as AIMessage;
        end();
        onSuccess(name);
        const inputTokens = msg.usage_metadata?.input_tokens ?? 0;
        const outputTokens = msg.usage_metadata?.output_tokens ?? 0;
        const costUsd = await recordUsage(opts.tenantId, name, inputTokens, outputTokens);
        llmRequests.inc({ tenant: opts.tenantId, model: name, outcome: 'success' });
        return { message: msg, model: name, inputTokens, outputTokens, costUsd, fallbacks, degraded: false };
      } catch (err) {
        end();
        onFailure(name);
        llmRequests.inc({ tenant: opts.tenantId, model: name, outcome: 'error' });
        const next = opts.modelChain[i + 1] ?? 'mock';
        llmFallbacks.inc({ from: name, to: next });
        fallbacks.push(`${name}:error`);
        logger.warn('llm call failed, falling back', { model: name, next, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Offline / degraded mode: deterministic mock with real tool_calls.
  const message = mockSupervisor(opts.messages, opts.user);
  const inputTokens = estimateTokens([new SystemMessage(opts.system), ...opts.messages]);
  const outputTokens = estimateTokens([message]);
  await recordUsage(opts.tenantId, 'mock', inputTokens, outputTokens);
  llmRequests.inc({ tenant: opts.tenantId, model: 'mock', outcome: 'success' });
  return { message, model: 'mock', inputTokens, outputTokens, costUsd: 0, fallbacks, degraded: config.llm.mode === 'openai' };
}
