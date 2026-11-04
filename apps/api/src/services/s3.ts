import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  // On AWS (ECS task role) leave the keys empty and the default credential chain is used.
  credentials: config.s3.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
    logger.info('s3 bucket created', { bucket: config.s3.bucket });
  }
}

/** Streams straight from the HTTP request into S3 multipart upload: the file is never buffered whole in memory. */
export async function streamToS3(key: string, body: Readable, contentType: string) {
  const upload = new Upload({
    client: s3,
    params: { Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });
  await upload.done();
}
