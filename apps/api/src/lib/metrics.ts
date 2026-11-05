/** Prometheus metrics (scraped from GET /metrics). Labels are kept low-cardinality on purpose. */
import client from 'prom-client';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'api' });
client.collectDefaultMetrics({ register: registry });

const make = <T>(m: T) => m;

export const httpDuration = make(new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP request latency', registers: [registry],
  labelNames: ['method', 'route', 'status'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
}));
export const agentRunDuration = make(new client.Histogram({
  name: 'agent_run_duration_seconds', help: 'End-to-end agent turn latency', registers: [registry],
  labelNames: ['tenant', 'intent', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40],
}));
export const llmRequests = make(new client.Counter({
  name: 'llm_requests_total', help: 'LLM calls by model and outcome', registers: [registry], labelNames: ['tenant', 'model', 'outcome'],
}));
export const llmLatency = make(new client.Histogram({
  name: 'llm_request_duration_seconds', help: 'LLM call latency', registers: [registry], labelNames: ['model'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
}));
export const llmTokens = make(new client.Counter({
  name: 'llm_tokens_total', help: 'Tokens consumed', registers: [registry], labelNames: ['tenant', 'model', 'type'],
}));
export const llmCost = make(new client.Counter({
  name: 'llm_cost_usd_total', help: 'Estimated LLM spend in USD', registers: [registry], labelNames: ['tenant', 'model'],
}));
export const llmFallbacks = make(new client.Counter({
  name: 'llm_fallbacks_total', help: 'Times the gateway fell back to the next model', registers: [registry], labelNames: ['from', 'to'],
}));
export const circuitState = make(new client.Gauge({
  name: 'llm_circuit_open', help: '1 when the circuit breaker for a model is open', registers: [registry], labelNames: ['model'],
}));
export const cacheRequests = make(new client.Counter({
  name: 'semantic_cache_requests_total', help: 'Semantic cache lookups', registers: [registry], labelNames: ['tenant', 'result'],
}));
export const guardrailBlocks = make(new client.Counter({
  name: 'guardrail_blocks_total', help: 'Requests blocked by guardrails', registers: [registry], labelNames: ['tenant', 'rule'],
}));
export const piiRedactions = make(new client.Counter({
  name: 'pii_redactions_total', help: 'PII entities redacted before LLM egress', registers: [registry], labelNames: ['tenant', 'type'],
}));
export const toolCalls = make(new client.Counter({
  name: 'agent_tool_calls_total', help: 'Tool executions', registers: [registry], labelNames: ['tenant', 'tool'],
}));
export const hitlDecisions = make(new client.Counter({
  name: 'hitl_decisions_total', help: 'Human-in-the-loop decisions', registers: [registry], labelNames: ['tenant', 'decision'],
}));
export const rateLimited = make(new client.Counter({
  name: 'rate_limited_total', help: 'Requests rejected by rate limiting or budget', registers: [registry], labelNames: ['tenant', 'reason'],
}));
export const eventsPublished = make(new client.Counter({
  name: 'domain_events_published_total', help: 'Domain events published to Kafka', registers: [registry], labelNames: ['type'],
}));
