/** Overlapping, structure-aware chunking via LangChain's RecursiveCharacterTextSplitter. */
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { config } from './config.js';
import type { ExtractedPage } from './extract.js';

export interface Chunk {
  chunkIndex: number;
  page: number;
  text: string;
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: config.chunk.size,
  chunkOverlap: config.chunk.overlap,
  separators: ['\n\n', '\n', '. ', '; ', ', ', ' ', ''],
});

export async function chunkPages(pages: ExtractedPage[]): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (const p of pages) {
    const cleaned = p.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    for (const text of await splitter.splitText(cleaned)) {
      if (text.trim().length < 20) continue;
      chunks.push({ chunkIndex: chunks.length, page: p.page, text });
    }
  }
  return chunks;
}
