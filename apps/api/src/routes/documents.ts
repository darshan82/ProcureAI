/**
 * Async document ingestion: stream upload -> S3, publish Kafka event, return 202 Accepted.
 * The worker service consumes the event, parses, chunks, embeds and indexes the document.
 */
import { Router, type Request } from 'express';
import busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getDb } from '../services/mongo.js';
import { publishIngest } from '../services/kafka.js';
import { streamToS3 } from '../services/s3.js';

export const documentsRouter = Router();

const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
]);

function receiveFile(req: Request, tenantId: string, documentId: string): Promise<{ filename: string; contentType: string; key: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: config.maxUploadBytes } });
    } catch {
      return reject(new HttpError(400, 'Expected multipart/form-data', 'bad_request'));
    }
    let handled = false;
    bb.on('file', (_field, stream, info) => {
      const original = info.filename ?? 'upload';
      handled = true;
      const ext = original.toLowerCase().match(/\.(pdf|txt|md)$/)?.[0];
      const contentType = ALLOWED.has(info.mimeType) ? info.mimeType : ext === '.pdf' ? 'application/pdf' : ext ? 'text/plain' : '';
      if (!contentType) {
        stream.resume();
        return reject(new HttpError(415, 'Only PDF, TXT and MD files are supported', 'unsupported_media_type'));
      }
      const safeName = original.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
      const key = `tenants/${tenantId}/uploads/${new Date().toISOString().slice(0, 10)}/${documentId}/${safeName}`;
      let bytes = 0;
      let truncated = false;
      stream.on('data', (d: Buffer) => (bytes += d.length));
      stream.on('limit', () => (truncated = true));
      streamToS3(key, stream, contentType)
        .then(() => (truncated
          ? reject(new HttpError(413, `File exceeds ${config.maxUploadBytes / 1024 / 1024} MB`, 'payload_too_large'))
          : resolve({ filename: safeName, contentType, key, bytes })))
        .catch(reject);
    });
    bb.on('error', reject);
    bb.on('close', () => { if (!handled) reject(new HttpError(400, 'No file field in upload', 'bad_request')); });
    req.pipe(bb);
  });
}

documentsRouter.post('/', requireAuth, requireRole('BUYER', 'SUPPLIER'), async (req, res) => {
  const user = req.user!;
  const documentId = `DOC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const jobId = randomUUID();
  const file = await receiveFile(req, user.tenantId, documentId);
  const now = new Date();
  const db = getDb();

  await db.collection('documents').insertOne({
    tenantId: user.tenantId, documentId, filename: file.filename, contentType: file.contentType, bytes: file.bytes, s3Key: file.key,
    uploadedBy: user.sub, role: user.role, status: 'QUEUED', chunkCount: 0, createdAt: now,
  });
  await db.collection('ingestion_jobs').insertOne({ tenantId: user.tenantId, jobId, documentId, status: 'QUEUED', createdAt: now, updatedAt: now });
  await publishIngest({
    jobId, tenantId: user.tenantId, documentId, bucket: config.s3.bucket, key: file.key, filename: file.filename, contentType: file.contentType,
    uploadedBy: user.sub, role: user.role, requestedAt: now.toISOString(),
  });
  logger.info('document queued for ingestion', { documentId, jobId, bytes: file.bytes });
  res.status(202).location(`/api/documents/jobs/${jobId}`).json({ accepted: true, jobId, documentId, status: 'QUEUED', statusUrl: `/api/documents/jobs/${jobId}` });
});

documentsRouter.get('/', requireAuth, requireRole('BUYER', 'SUPPLIER'), async (req, res) => {
  const docs = await getDb().collection('documents').find({ tenantId: req.user!.tenantId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ documents: docs });
});

documentsRouter.get('/jobs/:jobId', requireAuth, requireRole('BUYER', 'SUPPLIER'), async (req, res) => {
  const job = await getDb().collection('ingestion_jobs').findOne({ jobId: req.params.jobId, tenantId: req.user!.tenantId }, { projection: { _id: 0 } });
  if (!job) throw new HttpError(404, 'Job not found', 'not_found');
  res.json({ job });
});

documentsRouter.get('/:documentId', requireAuth, requireRole('BUYER', 'SUPPLIER'), async (req, res) => {
  const doc = await getDb().collection('documents').findOne({ documentId: String(req.params.documentId).toUpperCase(), tenantId: req.user!.tenantId }, { projection: { _id: 0 } });
  if (!doc) throw new HttpError(404, 'Document not found', 'not_found');
  res.json({ document: doc });
});
