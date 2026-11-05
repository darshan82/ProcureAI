/** RAG retrieval over ingested document chunks stored in MongoDB. */
import { config } from '../config.js';
import { getDb } from './mongo.js';
import { cosine, embedQuery, embeddingInfo } from './embeddings.js';

export interface RetrievedChunk {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

interface ChunkDoc {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingModel: string;
}

/** Drop passages whose text is identical (e.g. the same file uploaded twice). */
function dedupe(rows: RetrievedChunk[], k: number): RetrievedChunk[] {
  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const r of rows) {
    const key = r.text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length === k) break;
  }
  return out;
}

export async function searchChunks(tenantId: string, query: string, k = 4, documentId?: string): Promise<RetrievedChunk[]> {
  const vector = await embedQuery(query);
  const chunks = getDb().collection<ChunkDoc>('chunks');
  const filter: Record<string, unknown> = { tenantId, embeddingModel: embeddingInfo.model };
  if (documentId) filter.documentId = documentId;

  if (config.mongo.vectorSearch === 'atlas') {
    // MongoDB Atlas Vector Search ($vectorSearch needs an Atlas / atlas-local deployment + vector index).
    const rows = await chunks
      .aggregate<RetrievedChunk>([
        { $vectorSearch: { index: config.mongo.vectorIndex, path: 'embedding', queryVector: vector, numCandidates: k * 20, limit: k * 3, filter } },
        { $project: { _id: 0, documentId: 1, filename: 1, chunkIndex: 1, text: 1, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
    return dedupe(rows, k);
  }

  // Local fallback: brute-force cosine (fine for demo-scale corpora, O(n)).
  const candidates = await chunks
    .find(filter, { projection: { _id: 0, documentId: 1, filename: 1, chunkIndex: 1, text: 1, embedding: 1 } })
    .limit(5000)
    .toArray();
  const ranked = candidates
    .map((c) => ({ documentId: c.documentId, filename: c.filename, chunkIndex: c.chunkIndex, text: c.text, score: cosine(vector, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 3)
    .map((c) => ({ ...c, score: Math.round(c.score * 1000) / 1000 }));
  return dedupe(ranked, k);
}
