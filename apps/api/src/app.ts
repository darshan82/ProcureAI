import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { documentsRouter } from './routes/documents.js';
import { healthRouter } from './routes/health.js';
import { auditRouter, tendersRouter } from './routes/tenders.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    req.requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const t0 = performance.now();
    res.on('finish', () => {
      if (req.path.endsWith('/health')) return;
      logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - t0), requestId: req.requestId });
    });
    next();
  });

  app.use('/', healthRouter);
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/tenders', tendersRouter);
  app.use('/api/audit', auditRouter);

  app.use((_req, _res, next) => next(new HttpError(404, 'Route not found', 'not_found')));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'bad_request', message: 'Invalid request body', details: err.issues });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    }
    logger.error('unhandled error', { err: err instanceof Error ? err.stack : String(err), requestId: req.requestId });
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong', requestId: req.requestId });
  });

  return app;
}
