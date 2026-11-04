import { Kafka, logLevel, type Producer } from 'kafkajs';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const kafka = new Kafka({ clientId: config.kafka.clientId, brokers: config.kafka.brokers, logLevel: logLevel.WARN });
let producer: Producer | null = null;

export async function connectKafka() {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  if (!existing.includes(config.kafka.ingestTopic)) {
    await admin.createTopics({ topics: [{ topic: config.kafka.ingestTopic, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
    logger.info('kafka topic created', { topic: config.kafka.ingestTopic });
  }
  await admin.disconnect();
  producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  logger.info('kafka producer connected', { brokers: config.kafka.brokers });
}

export interface IngestMessage {
  jobId: string;
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
    messages: [{ key: msg.documentId, value: JSON.stringify(msg), headers: { 'content-type': 'application/json' } }],
  });
}

export async function closeKafka() {
  await producer?.disconnect();
}
