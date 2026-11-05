import { Kafka, logLevel, type Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { eventsPublished } from '../lib/metrics.js';

export const EVENTS_TOPIC = process.env.KAFKA_EVENTS_TOPIC ?? 'procurement.events';
export const EVENTS_DLQ_TOPIC = `${EVENTS_TOPIC}.dlq`;

const kafka = new Kafka({ clientId: config.kafka.clientId, brokers: config.kafka.brokers, logLevel: logLevel.WARN });
let producer: Producer | null = null;

export async function connectKafka() {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  const wanted = [config.kafka.ingestTopic, EVENTS_TOPIC, EVENTS_DLQ_TOPIC].filter((t) => !existing.includes(t));
  if (wanted.length) {
    await admin.createTopics({ topics: wanted.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })), waitForLeaders: true });
    logger.info('kafka topics created', { topics: wanted });
  }
  await admin.disconnect();
  producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  logger.info('kafka producer connected', { brokers: config.kafka.brokers });
}

export interface IngestMessage {
  jobId: string;
  tenantId: string;
  documentId: string;
  bucket: string;
  key: string;
  filename: string;
  contentType: string;
  uploadedBy: string;
  role: string;
  requestedAt: string;
}

export async function publishIngest(msg: IngestMessage) {
  if (!producer) throw new Error('Kafka producer not connected');
  await producer.send({
    topic: config.kafka.ingestTopic,
    messages: [{ key: msg.documentId, value: JSON.stringify(msg), headers: { 'content-type': 'application/json', tenant: msg.tenantId } }],
  });
}

export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  type: string;
  tenantId: string;
  occurredAt: string;
  actor?: string;
  data: T;
}

/**
 * Publish a domain event (tender.created, bid.submitted, tender.awarded, approval.requested...).
 * Keyed by tenant so each tenant's events stay ordered. The worker's integration dispatcher
 * fans them out to customer systems as signed webhooks. Best-effort: never fails the user request.
 */
export async function publishEvent(tenantId: string, type: string, data: Record<string, unknown>, actor?: string) {
  if (!producer) return;
  const event: DomainEvent = { eventId: `evt_${randomUUID()}`, type, tenantId, occurredAt: new Date().toISOString(), actor, data };
  try {
    await producer.send({ topic: EVENTS_TOPIC, messages: [{ key: tenantId, value: JSON.stringify(event), headers: { type, tenant: tenantId } }] });
    eventsPublished.inc({ type });
  } catch (err) {
    logger.error('failed to publish domain event', { type, tenantId, err: String(err) });
  }
}

export async function republishRaw(topic: string, key: string, value: string) {
  if (!producer) throw new Error('Kafka producer not connected');
  await producer.send({ topic, messages: [{ key, value }] });
}

export async function closeKafka() {
  await producer?.disconnect();
}
