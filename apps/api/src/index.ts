import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { closeMongo, connectMongo, seedTenders } from './services/mongo.js';
import { loadTenantConfigs } from './services/tenants.js';
import { initGraph } from './agent/graph.js';
import { connectRedis } from './services/semanticCache.js';
import { closeKafka, connectKafka } from './services/kafka.js';
import { ensureBucket } from './services/s3.js';

async function retry<T>(name: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn(`${name} not ready, retrying`, { attempt: i, err: String(err) });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  logger.info('starting api', { llmMode: config.llm.mode, model: config.llm.mode === 'openai' ? config.llm.model : 'mock' });
  if (config.llm.mode === 'mock') {
    logger.warn('OPENAI_API_KEY not set: running with the offline mock LLM + hash embeddings');
  }
  await retry('mongo', connectMongo);
  await loadTenantConfigs();
  await seedTenders();
  initGraph();
  await retry('redis', connectRedis);
  await retry('s3', ensureBucket);
  await retry('kafka', connectKafka);

  const server = createApp().listen(config.port, () => logger.info('api listening', { port: config.port }));

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    server.close();
    await Promise.allSettled([closeKafka(), closeMongo()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('fatal startup error', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
