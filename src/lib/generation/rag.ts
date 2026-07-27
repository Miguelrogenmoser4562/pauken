/* RAG utilities: chunk, embed, and retrieve source passages.
   Uses engine.embed() for embedding and cosine similarity for retrieval. */

import type { Engine } from "../engine/types";
import type { SourceChunk } from "../types";
import { uuid } from "../ids";
import { chunkByTokensWithOffsets } from "./chunk";

const CHUNK_TOKENS = 512;
const TOP_K = 3;

/* Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/* Chunk source text and embed each chunk.
   Tracks character positions for accurate source citations.
   Pass sourceName to tag chunks from a specific source file. */
export async function chunkAndEmbed(
  engine: Engine,
  noteId: string,
  sourceText: string,
  sourceName?: string,
): Promise<SourceChunk[]> {
  const sized = chunkByTokensWithOffsets(sourceText, CHUNK_TOKENS, 50);
  if (sized.length === 0) return [];

  const texts = sized.map((c) => c.text);
  const embeddings = await engine.embed(texts);

  return sized.map((c, i) => ({
    id: uuid(),
    noteId,
    index: i,
    text: c.text,
    embedding: embeddings[i],
    charStart: c.charStart,
    charEnd: c.charEnd,
    sourceName,
  }));
}

/* Find the top-k most relevant chunks for a query. */
export function retrieveRelevantChunks(
  chunks: SourceChunk[],
  queryEmbedding: number[],
  topK: number = TOP_K,
): SourceChunk[] {
  const scored = chunks
    .filter((c) => c.embedding)
    .map((c) => ({
      chunk: c,
      score: cosineSimilarity(queryEmbedding, c.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map((s) => s.chunk);
}

/* Build a context string from chunks for use in generation prompts.
   Includes position metadata and source name so the LLM can cite
   precise locations. */
export function chunksToContext(chunks: SourceChunk[]): string {
  return chunks
    .map((c, i) => {
      const source = c.sourceName ? `${c.sourceName}, ` : "";
      return `[Passage ${i + 1} — ${source}chars ${c.charStart}–${c.charEnd}]\n${c.text}`;
    })
    .join("\n\n");
}
