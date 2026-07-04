/**
 * Deterministic, in-process feature-hash embedder.
 *
 * Uses character + word n-grams (1..3) hashed into a fixed-dimension vector.
 * Same input always produces the same vector. Cosine similarity is computed
 * in-process — no external services.
 *
 * Not a learned model. It captures lexical overlap, not semantic meaning.
 * For a single-user memory corpus that's enough.
 */

/** Default embedding dimension from config. */
export function defaultDim(): number {
  const raw = process.env.OPENMEMORY_DIM;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 16 && n <= 4096) return n;
  }
  return 256;
}

/** Embed a string into a unit-length vector.
 *
 * Pass `idf` to weight each n-gram by its inverse document frequency in the
 * corpus. Without `idf`, each n-gram contributes ±1 (legacy behaviour). With
 * `idf`, the contribution is ±max(idf.get(ng), 0). Common terms shrink
 * toward zero and stop pulling unrelated documents together.
 */
export function embed(text: string, dimensions?: number, idf?: Map<string, number>): number[] {
  const dims = clampDim(dimensions ?? defaultDim());
  const vec = new Array<number>(dims).fill(0);
  const ngrams = collectNgrams(tokenize(text), 1, 3);

  for (const ng of ngrams) {
    const h = hash32(ng);
    const slot = ((h % dims) + dims) % dims;
    const sign = h % 2 === 0 ? 1 : -1;
    const w = idf ? Math.max(idf.get(ng) ?? 0, 0) : 1;
    if (w === 0) continue;
    vec[slot] += sign * w;
  }

  return l2Normalize(vec);
}

/** BM25-style inverse document frequency for a term.
 *
 *  idf(t) = ln( (N - df + 0.5) / (df + 0.5) + 1 )
 *
 * Clamped to a floor so a term present in every document does not collapse
 * to a no-op magnitude.
 */
export function bm25Idf(df: number, totalDocs: number): number {
  if (totalDocs <= 0) return 1;
  if (df <= 0) return 1;
  const n = totalDocs;
  const raw = Math.log((n - df + 0.5) / (df + 0.5) + 1);
  return Math.max(raw, 0.05);
}

/** Cosine similarity. Returns 0 for empty or length-mismatched inputs. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((s) => s.length > 0);
}

function collectNgrams(tokens: string[], minN: number, maxN: number): string[] {
  const out: string[] = [];
  for (let n = minN; n <= maxN; n++) {
    if (tokens.length < n) continue;
    for (let i = 0; i <= tokens.length - n; i++) {
      out.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return out;
}

// Re-export for callers that need the same n-gram set (e.g. df bookkeeping).
export const _internals = { tokenize, collectNgrams };

function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((x) => x / norm);
}

function clampDim(d: number): number {
  if (!Number.isFinite(d)) return defaultDim();
  return Math.max(16, Math.min(4096, Math.floor(d)));
}

/** Stable 32-bit hash. FNV-1a — fast and good enough for hashing trick. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}