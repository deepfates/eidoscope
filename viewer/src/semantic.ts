// The semantic-query primitive (the keystone). Embed a free-text query with the SAME model that made
// the carried card vectors (Xenova/all-MiniLM-L6-v2, pooling mean, normalized) — proven in Node to
// rank the real corpus sensibly — then cosine-rank every card. The per-card scalar becomes a synthetic
// AXIS, so it flows through the existing channel grammar (color / size / x / y) with no per-channel wiring.
//
// The EMBEDDING half lives in the engine Web Worker (viewer/src/embedder.ts, reached through the client
// in viewer/src/ingest.ts) so the ~23MB model download and the inference never block a frame. This
// module is the main-thread half: the cosine ranking over the carried vectors — pure arithmetic, no
// transformers.js in the main bundle at all.

import type { CardVectors } from "../../src/schema";

// Cosine of the query against every card vector (card vectors are mean-pooled, not necessarily unit-norm,
// so normalize per-card here). Returns raw cosine per card.
export function cosineAll(query: Float32Array, vectors: CardVectors): number[] {
  const { data, dim } = vectors, n = (data.length / dim) | 0, out = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    const base = r * dim;
    let d = 0, nv = 0;
    for (let i = 0; i < dim; i++) { const v = data[base + i]; d += query[i] * v; nv += v * v; }
    out[r] = d / (Math.sqrt(nv) || 1);
  }
  return out;
}
// (scale100/rankNorm100 removed — the registry's scores01 in dimensions.ts owns raw→0..100 for every dimension,
// query axes included, applying the per-dimension norm/invert props uniformly.)
