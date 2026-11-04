/**
 * Embeddings: OpenAI when a key is configured, otherwise a deterministic local
 * "hashing" embedder so the whole platform (RAG + semantic cache) works offline.
 */
import { OpenAIEmbeddings } from '@langchain/openai';
import { config } from '../config.js';

const MOCK_DIM = 384;
const STOPWORDS = new Set(
  'a an the is are was were be to of and or in on for with what which who how do does did can could please me my i you your show list give tell about any all'.split(' '),
);

export const embeddingInfo =
  config.llm.mode === 'openai'
    ? { model: config.llm.embeddingModel, dim: config.llm.embeddingDim }
    : { model: `mock-hash-${MOCK_DIM}`, dim: MOCK_DIM };

let openai: OpenAIEmbeddings | null = null;
function client() {
  if (!openai) {
    openai = new OpenAIEmbeddings({
      apiKey: config.llm.openaiKey,
      model: config.llm.embeddingModel,
      dimensions: config.llm.embeddingDim,
      batchSize: 256,
    });
  }
  return openai;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t)); // naive plural folding
}

/** Feature-hashing bag of unigrams + bigrams, L2-normalised. */
export function mockEmbed(text: string): number[] {
  const v = new Array<number>(MOCK_DIM).fill(0);
  const tokens = tokenize(text);
  const feats = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
  for (const f of feats) {
    const h = fnv1a(f);
    v[h % MOCK_DIM] += h & 0x80000000 ? -1 : 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export async function embedQuery(text: string): Promise<number[]> {
  return config.llm.mode === 'openai' ? client().embedQuery(text) : mockEmbed(text);
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return config.llm.mode === 'openai' ? client().embedDocuments(texts) : texts.map(mockEmbed);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
