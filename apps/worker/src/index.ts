/**
 * Ingestion worker: consumes `document.ingest` events from Kafka.
 * S3 stream -> parse -> overlapping chunks -> batch embeddings -> MongoDB bulk upsert
 * -> mark document READY -> invalidate the semantic cache (answers may now be stale).
 */
import { createServer } from 'node:http';
import { Kafka, logLevel } from 'kafkajs';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { config } from './config.js';
import { logger } from './logger.js';
import { downloadToTemp, extractText } from './extract.js';
import { chunkPages } from './chunker.js';
import { embedDocuments, embeddingInfo } from './embeddings.js';

interface IngestMessage {
  jobId: string;
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
const consumer = kafka.consumer({ groupId: config.kafka.groupId, sessionTimeout: 60_000, heartbeatInterval: 3_000 });
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

async function invalidateSemanticCache() {
  let deleted = 0;
  for await (const keys of redis.scanIterator({ MATCH: 'semcache:*', COUNT: 500 })) {
    const batch = Array.isArray(keys) ? keys : [keys];
    if (batch.length) deleted += await redis.del(batch);
  }
  return deleted;
}

async function processMessage(msg: IngestMessage, heartbeat: () => Promise<void>) {
  const db = mongo.db(config.mongo.db);
  const jobs = db.collection('ingestion_jobs');
  const docs = db.collection('documents');
  const setJob = (status: string, extra: Record<string, unknown> = {}) =>
    jobs.updateOne({ jobId: msg.jobId }, { $set: { status, updatedAt: new Date(), ...extra } });

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
                documentId: msg.documentId, filename: msg.filename, chunkIndex: c.chunkIndex, page: c.page, text: c.text,
                embedding: vectors[j], embeddingModel: embeddingInfo.model, embeddingDim: embeddingInfo.dim, createdAt: new Date(),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      await heartbeat(); // keep the consumer alive during long documents
    }

    const ms = Math.round(performance.now() - t0);
    await docs.updateOne({ documentId: msg.documentId }, { $set: { status: 'READY', chunkCount: chunks.length, pages: pages.length, processedAt: new Date(), processingMs: ms } });
    await setJob('COMPLETED', { stage: 'done', chunkCount: chunks.length, pages: pages.length, processingMs: ms });
    const invalidated = await invalidateSemanticCache();
    processed++;
    logger.info('document ingested', { documentId: msg.documentId, bytes: file.bytes, pages: pages.length, chunks: chunks.length, ms, cacheInvalidated: invalidated, embeddings: embeddingInfo.model });
  } finally {
    await file.cleanup();
  }
}

async function main() {
  logger.info('starting worker', { embeddings: embeddingInfo.model, topic: config.kafka.ingestTopic });
  await retry('mongo', () => mongo.connect());
  redis.on('error', (e) => logger.error('redis error', { err: String(e) }));
  await retry('redis', () => redis.connect());
  await retry('kafka', () => consumer.connect());
  await retry('kafka-subscribe', () => consumer.subscribe({ topic: config.kafka.ingestTopic, fromBeginning: true }));

  await consumer.run({
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
        logger.error('ingestion failed', { documentId: msg.documentId, err: err instanceof Error ? err.message : String(err) });
        const db = mongo.db(config.mongo.db);
        await db.collection('ingestion_jobs').updateOne({ jobId: msg.jobId }, { $set: { status: 'FAILED', error: String(err instanceof Error ? err.message : err), updatedAt: new Date() } });
        await db.collection('documents').updateOne({ documentId: msg.documentId }, { $set: { status: 'FAILED' } });
        // Not rethrown: failures are recorded and the offset commits, so one bad file can't block the partition.
      }
    },
  });
  ready = true;
  logger.info('worker consuming');
}

createServer((req, res) => {
  const ok = req.url === '/health' || ready;
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'starting', ready, processed, failed }));
}).listen(config.healthPort);

const shutdown = async () => {
  logger.info('shutting down');
  await Promise.allSettled([consumer.disconnect(), mongo.close(), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  logger.error('fatal', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
