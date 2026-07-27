/* Token budgeting + chunking so documents of ANY size can be turned into notes
   without exceeding a model's context window or a low tokens-per-minute (TPM)
   rate limit. Estimation is a conservative chars/4 heuristic (good enough for
   budgeting; the engine's own backoff handles the edges). */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* Trim text to at most `maxTokens` (keeps the head, where the important context
   usually is). Used for study-tool grounding where a distilled slice is fine. */
export function capTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export interface TextChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

/* Split text into chunks each <= maxTokens, breaking on paragraph then sentence
   then hard-char boundaries so we never split mid-word when avoidable. Optional
   overlap (in tokens) preserves context across chunk seams for coherent notes.
   Returns plain strings (backward-compatible). */
export function chunkByTokens(
  text: string,
  maxTokens: number,
  overlapTokens = 0,
): string[] {
  return chunkByTokensWithOffsets(text, maxTokens, overlapTokens).map((c) => c.text);
}

/* Split text into chunks each <= maxTokens, returning both text and character
   position offsets for accurate source citations. */
export function chunkByTokensWithOffsets(
  text: string,
  maxTokens: number,
  overlapTokens = 0,
): TextChunk[] {
  const maxChars = Math.max(200, maxTokens * 4);
  if (text.length <= maxChars) {
    return text.trim() ? [{ text, charStart: 0, charEnd: text.length }] : [];
  }

  const units = splitUnitsWithOffsets(text, maxChars);
  const chunks: TextChunk[] = [];
  let cur = "";
  let curStart = 0;
  for (const u of units) {
    if (cur && cur.length + u.text.length + 2 > maxChars) {
      chunks.push({ text: cur.trim(), charStart: curStart, charEnd: curStart + cur.trim().length });
      const overlapChars = overlapTokens * 4;
      const tail = overlapChars > 0 ? cur.slice(-overlapChars) : "";
      if (tail) {
        curStart = curStart + cur.length - overlapChars;
        cur = tail;
      } else {
        cur = "";
        curStart = u.charStart;
      }
    }
    if (!cur) curStart = u.charStart;
    cur += (cur ? "\n\n" : "") + u.text;
  }
  if (cur.trim()) {
    chunks.push({ text: cur.trim(), charStart: curStart, charEnd: curStart + cur.trim().length });
  }
  return chunks;
}

/* Paragraphs, further split if a single paragraph exceeds the budget.
   Tracks character positions for accurate source citations. */
function splitUnitsWithOffsets(text: string, maxChars: number): TextChunk[] {
  const out: TextChunk[] = [];
  let offset = 0;
  const paras = text.split(/\n\s*\n/);
  for (const p of paras) {
    const paraStart = offset;
    if (p.length <= maxChars) {
      const trimmed = p.trim();
      if (trimmed) {
        const trimOffset = p.indexOf(trimmed);
        out.push({ text: trimmed, charStart: paraStart + trimOffset, charEnd: paraStart + trimOffset + trimmed.length });
      }
      offset += p.length + 2; // +2 for the \n\n separator
      continue;
    }
    // huge paragraph: split on sentence boundaries, then hard-slice.
    const sentences = p.split(/(?<=[.!?])\s+/);
    let buf = "";
    let bufStart = paraStart;
    for (const s of sentences) {
      if (s.length > maxChars) {
        if (buf.trim()) {
          const trimmed = buf.trim();
          const trimOffset = buf.indexOf(trimmed);
          out.push({ text: trimmed, charStart: bufStart + trimOffset, charEnd: bufStart + trimOffset + trimmed.length });
          buf = "";
        }
        for (let i = 0; i < s.length; i += maxChars) {
          const slice = s.slice(i, i + maxChars);
          out.push({ text: slice, charStart: paraStart + i, charEnd: paraStart + Math.min(i + maxChars, s.length) });
        }
        continue;
      }
      if (buf.length + s.length + 1 > maxChars) {
        if (buf.trim()) {
          const trimmed = buf.trim();
          const trimOffset = buf.indexOf(trimmed);
          out.push({ text: trimmed, charStart: bufStart + trimOffset, charEnd: bufStart + trimOffset + trimmed.length });
          buf = "";
        }
        bufStart = paraStart + p.indexOf(s);
      }
      if (!buf) bufStart = paraStart + p.indexOf(s);
      buf += (buf ? " " : "") + s;
    }
    if (buf.trim()) {
      const trimmed = buf.trim();
      const trimOffset = buf.indexOf(trimmed);
      out.push({ text: trimmed, charStart: bufStart + trimOffset, charEnd: bufStart + trimOffset + trimmed.length });
    }
    offset += p.length + 2;
  }
  return out;
}
