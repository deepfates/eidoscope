// The semantic-query primitive (the keystone). Embed a free-text query IN THE BROWSER with the SAME model
// that made the carried card vectors (Xenova/all-MiniLM-L6-v2, pooling mean, normalized) — proven in Node to
// rank the real corpus sensibly — then cosine-rank every card. The per-card scalar becomes a synthetic AXIS,
// so it flows through the existing channel grammar (color / size / x / y) with no per-channel wiring.
//
// The embedder lives in the APP (never the file): transformers.js is lazy-loaded from a CDN on first query
// (~small js; the MiniLM weights ~23MB stream from the HF hub once, then cache). This matches the architecture
// — the .eido carries the vectors (the value); the app carries the runtime. The embedder id is pinned to the
// file's derivedBy.embedder.id so a query lands in the SAME space as the cards.

const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
let extractorP: Promise<any> | null = null;

// Load transformers.js + the model once. `id` should be the file's derivedBy.embedder.id.
async function extractor(id: string): Promise<any> {
  if (!extractorP) {
    extractorP = (async () => {
      const t: any = await import(/* @vite-ignore */ CDN);
      // let onnxruntime-web fetch its wasm from the same CDN (no local asset wiring needed)
      if (t.env?.backends?.onnx?.wasm) t.env.backends.onnx.wasm.wasmPaths = CDN + "/dist/";
      return t.pipeline("feature-extraction", id);
    })();
  }
  return extractorP;
}

export function embedderReady(): boolean { return extractorP != null; }

// Embed one query → unit-normalized Float32Array (384 dims for MiniLM).
export async function embedQuery(text: string, embedderId = "Xenova/all-MiniLM-L6-v2"): Promise<Float32Array> {
  const ex = await extractor(embedderId);
  const out = await ex(text, { pooling: "mean", normalize: true });
  return out.data as Float32Array;
}

// Cosine of the query against every card vector (card vectors are mean-pooled, not necessarily unit-norm,
// so normalize per-card here). Returns raw cosine per card.
export function cosineAll(query: Float32Array, vectors: number[][]): number[] {
  const dim = query.length;
  return vectors.map((v) => {
    let d = 0, nv = 0;
    for (let i = 0; i < dim; i++) { d += query[i] * v[i]; nv += v[i] * v[i]; }
    return d / (Math.sqrt(nv) || 1);
  });
}

// Min–max scale similarities into 0..100 RELATIVE TO THIS SET (the thesis: compared to each other, not a
// vacuum). Uses the full visual range; if the corpus barely contains the query, the whole band is low/flat.
export function scale100(sims: number[]): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const s of sims) { if (s < lo) lo = s; if (s > hi) hi = s; }
  const r = hi - lo || 1;
  return sims.map((s) => ((s - lo) / r) * 100);
}
