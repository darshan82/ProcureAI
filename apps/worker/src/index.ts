/**
 * Worker process with two Kafka consumer groups:
 *  1. ingestion-workers      (document.ingest)    S3 stream -> parse -> chunk -> batch embed -> Mongo vectors
 *                                                 -> structured contract extraction -> document.ingested event
 *  2. integration-dispatcher (procurement.events) signed webhooks to customer systems with retries + DLQ
 */
import { createServer } from 'node:http';
import { Kafka, logLevel } from 'kafkajs';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { downloadToTemp, extractText } from './extract.js';
import { chunkPages } from './chunker.js';
import { embedDocuments, embeddingInfo } from './embeddings.js';
import { extractContract } from './extraction.js';
import { dispatchEvent, EVENTS_TOPIC } from './dispatcher.js';
import { chunksIndexed, ingestDuration, ingestJobs, registry } from './metrics.js';

interface IngestMessage {
  jobId: string;
  tenantId: string;
  documentId: string;
  bucket: string;
  key: string;
  filename: string;
  contentType: string;
  uploadedBy: string;
  role: string;
}

const mongo = new MongoClient(config.mongo.url);
const redis = createClient({ url: config.redisUrl });
const kafka = new Kafka({ clientId: config.kafka.clientId, brokers: config.kafka.brokers, logLevel: logLevel.WARN });
const ingestConsumer = kafka.consumer({ groupId: config.kafka.groupId, sessionTimeout: 60_000, heartbeatInterval: 3_000 });
const dispatchConsumer = kafka.consumer({ groupId: process.env.KAFKA_DISPATCH_GROUP_ID ?? 'integration-dispatcher', sessionTimeout: 60_000, heartbeatInterval: 3_000 });
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
let processed = 0;
let failed = 0;
let ready = false;

async function retry<T>(name: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= attempts) throw err;
      logger.warn(`${name} not ready, retrying`, { attempt: i, err: String(err) });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function invalidateTenantCache(tenantId: string) {
  let deleted = 0;
  const safe = tenantId.replace(/[^a-zA-Z0-9_]/g, '_');
  for await (const keys of redis.scanIterator({ MATCH: `semcache:*:${safe}:*`, COUNT: 500 })) {
    const batch = Array.isArray(keys) ? keys : [keys];
    if (batch.length) deleted += await redis.del(batch);
  }
  return deleted;
}

async function publishEvent(tenantId: string, type: string, data: Record<string, unknown>) {
  const event = { eventId: `evt_${randomUUID()}`, type, tenantId, occurredAt: new Date().toISOString(), actor: 'ingestion-worker', data };
  await producer.send({ topic: EVENTS_TOPIC, messages: [{ key: tenantId, value: JSON.stringify(event), headers: { type, tenant: tenantId } }] }).catch((e) =>
    logger.error('event publish failed', { type, err: String(e) }));
}

async function processMessage(msg: IngestMessage, heartbeat: () => Promise<void>) {
  const db = mongo.db(config.mongo.db);
  const jobs = db.collection('ingestion_jobs');
  const docs = db.collection('documents');
  const setJob = (status: string, extra: Record<string, unknown> = {}) =>
    jobs.updateOne({ jobId: msg.jobId }, { $set: { status, updatedAt: new Date(), ...extra } });

  const endTimer = ingestDuration.startTimer({ tenant: msg.tenantId });
  const t0 = performance.now();
  await setJob('PROCESSING', { stage: 'download' });
  await docs.updateOne({ documentId: msg.documentId }, { $set: { status: 'PROCESSING' } });

  const file = await downloadToTemp(msg.bucket, msg.key);
  try {
    await setJob('PROCESSING', { stage: 'parse' });
    const pages = await extractText(file.path, msg.contentType);
    if (!pages.length) throw new Error('No extractable text (scanned PDF? OCR is not enabled)');

    await setJob('PROCESSING', { stage: 'chunk' });
    const chunks = await chunkPages(pages);

    await setJob('PROCESSING', { stage: 'embed', chunkCount: chunks.length });
    const col = db.collection('chunks');
    await col.deleteMany({ documentId: msg.documentId }); // idempotent re-processing
    for (let i = 0; i < chunks.length; i += config.embedBatchSize) {
      const batch = chunks.slice(i, i + config.embedBatchSize);
      const vectors = await embedDocuments(batch.map((c) => c.text));
      await col.bulkWrite(
        batch.map((c, j) => ({
          updateOne: {
            filter: { _id: `${msg.documentId}:${c.chunkIndex}` as any },
            update: {
              $set: {
                tenantId: msg.tenantId, documentId: msg.documentId, filename: msg.filename, chunkIndex: c.chunkIndex, page: c.page, text: c.text,
                embedding: vectors[j], embeddingModel: embeddingInfo.model, embeddingDim: embeddingInfo.dim, createdAt: new Date(),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      chunksIndexed.inc({ tenant: msg.tenantId }, batch.length);
      await heartbeat(); // keep the consumer alive during long documents
    }

    await setJob('PROCESSING', { stage: 'extract' });
    const fullText = pages.map((p) => p.text).join('\n\n');
    const extraction = await extractContract(fullText, msg.filename);

    const ms = Math.round(performance.now() - t0);
    await docs.updateOne({ documentId: msg.documentId }, { $set: { status: 'READY', chunkCount: chunks.length, pages: pages.length, processedAt: new Date(), processingMs: ms, extraction } });
    await setJob('COMPLETED', { stage: 'done', chunkCount: chunks.length, pages: pages.length, processingMs: ms });
    const invalidated = await invalidateTenantCache(msg.tenantId);
    await publishEvent(msg.tenantId, 'document.ingested', {
      documentId: msg.documentId, filename: msg.filename, chunks: chunks.length, pages: pages.length,
      riskFlags: extraction.risks.length, highRisks: extraction.risks.filter((r) => r.severity === 'high').map((r) => r.description),
    });
    processed++;
    ingestJobs.inc({ tenant: msg.tenantId, status: 'completed' });
    logger.info('document ingested', { tenantId: msg.tenantId, documentId: msg.documentId, bytes: file.bytes, pages: pages.length, chunks: chunks.length, ms, cacheInvalidated: invalidated, extraction: extraction.method, risks: extraction.risks.length });
  } finally {
    endTimer();
    await file.cleanup();
  }
}

async function main() {
  logger.info('starting worker', { embeddings: embeddingInfo.model, topics: [config.kafka.ingestTopic, EVENTS_TOPIC] });
  await retry('mongo', () => mongo.connect());
  redis.on('error', (e) => logger.error('redis error', { err: String(e) }));
  await retry('redis', () => redis.connect());
  await retry('kafka-producer', () => producer.connect());
  await retry('kafka-ingest', () => ingestConsumer.connect());
  await retry('kafka-dispatch', () => dispatchConsumer.connect());
  await retry('kafka-subscribe', () => ingestConsumer.subscribe({ topic: config.kafka.ingestTopic, fromBeginning: true }));
  await retry('kafka-subscribe-events', () => dispatchConsumer.subscribe({ topic: EVENTS_TOPIC, fromBeginning: false }));
  const db = mongo.db(config.mongo.db);

  await ingestConsumer.run({
    partitionsConsumedConcurrently: 2,
    eachMessage: async ({ message, heartbeat, partition }) => {
      let msg: IngestMessage;
      try {
        msg = JSON.parse(message.value?.toString() ?? '{}');
      } catch {
        logger.error('poison message skipped', { partition, offset: message.offset });
        return;
      }
      try {
        await processMessage(msg, heartbeat);
      } catch (err) {
        failed++;
        ingestJobs.inc({ tenant: msg.tenantId ?? 'unknown', status: 'failed' });
        logger.error('ingestion failed', { documentId: msg.documentId, err: err instanceof Error ? err.message : String(err) });
        await db.collection('ingestion_jobs').updateOne({ jobId: msg.jobId }, { $set: { status: 'FAILED', error: String(err instanceof Error ? err.message : err), updatedAt: new Date() } });
        await db.collection('documents').updateOne({ documentId: msg.documentId }, { $set: { status: 'FAILED' } });
        // Not rethrown: failures are recorded and the offset commits, so one bad file can't block the partition.
      }
    },
  });

  await dispatchConsumer.run({
    partitionsConsumedConcurrently: 3,
    eachMessage: async ({ message, heartbeat }) => {
      try {
        await dispatchEvent(db, producer, JSON.parse(message.value?.toString() ?? '{}'), heartbeat);
      } catch (err) {
        logger.error('dispatch failed', { offset: message.offset, err: String(err) });
      }
    },
  });

  ready = true;
  logger.info('worker consuming');
}

createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': registry.contentType });
    return res.end(await registry.metrics());
  }
  const ok = req.url === '/health' || ready;
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'starting', ready, processed, failed }));
}).listen(config.healthPort);

const shutdown = async () => {
  logger.info('shutting down');
  await Promise.allSettled([ingestConsumer.disconnect(), dispatchConsumer.disconnect(), producer.disconnect(), mongo.close(), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  logger.error('fatal', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});

