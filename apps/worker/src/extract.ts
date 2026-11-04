/**
 * S3 -> temp file streaming (constant memory while downloading) -> text extraction.
 * PDF parsing needs random access to the file, so we spool to disk instead of buffering
 * the whole S3 object on the heap; plain-text files are read line by line.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { PDFParse } from 'pdf-parse';
import { config } from './config.js';

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: config.s3.accessKeyId ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } : undefined,
});

export interface ExtractedPage {
  page: number;
  text: string;
}

export async function downloadToTemp(bucket: string, key: string): Promise<{ path: string; bytes: number; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  const path = join(dir, 'source');
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!obj.Body) throw new Error(`Empty S3 object s3://${bucket}/${key}`);
  await pipeline(obj.Body as Readable, createWriteStream(path));
  const { size } = await stat(path);
  return { path, bytes: size, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function extractText(path: string, contentType: string): Promise<ExtractedPage[]> {
  if (contentType === 'application/pdf') {
    const parser = new PDFParse({ data: new Uint8Array(await readFile(path)) });
    try {
      const result = await parser.getText();
      return result.pages.map((p) => ({ page: p.num, text: p.text })).filter((p) => p.text.trim());
    } finally {
      await parser.destroy();
    }
  }
  // Text / markdown: stream lines, group every ~60 lines as a logical "page".
  const pages: ExtractedPage[] = [];
  let buf: string[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    buf.push(line);
    if (buf.length >= 60) {
      pages.push({ page: pages.length + 1, text: buf.join('\n') });
      buf = [];
    }
  }
  if (buf.length) pages.push({ page: pages.length + 1, text: buf.join('\n') });
  return pages.filter((p) => p.text.trim());
}
