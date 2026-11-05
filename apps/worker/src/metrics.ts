import client from 'prom-client';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'worker' });
client.collectDefaultMetrics({ register: registry });

export const ingestJobs = new client.Counter({ name: 'ingestion_jobs_total', help: 'Ingestion jobs by outcome', labelNames: ['tenant', 'status'], registers: [registry] });
export const ingestDuration = new client.Histogram({
  name: 'ingestion_duration_seconds', help: 'Document ingestion time', labelNames: ['tenant'], registers: [registry],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
});
export const chunksIndexed = new client.Counter({ name: 'chunks_indexed_total', help: 'Chunks embedded and stored', labelNames: ['tenant'], registers: [registry] });
export const extractions = new client.Counter({ name: 'contract_extractions_total', help: 'Structured contract extractions', labelNames: ['method', 'status'], registers: [registry] });
export const webhookDeliveries = new client.Counter({ name: 'webhook_deliveries_total', help: 'Webhook delivery outcomes', labelNames: ['tenant', 'status'], registers: [registry] });
export const webhookLatency = new client.Histogram({
  name: 'webhook_delivery_duration_seconds', help: 'Webhook HTTP latency per attempt', registers: [registry], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});
