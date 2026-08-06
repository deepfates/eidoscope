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

// Progress the caller can surface while the (one-time) model download runs — so the first query isn't a
// silent 30s freeze. `pct` is 0..100 during download; `phase` distinguishes the runtime/model fetch from embed.
export type EmbedProgress = { phase: "runtime" | "download" | "embed"; pct?: number; label: string };

// Load transformers.js + the model once. `id` should be the file's derivedBy.embedder.id. On ANY failure the
// cached promise is cleared so a retry starts clean (a throttled/aborted CDN fetch shouldn't poison later tries).
async function extractor(id: string, onProgress?: (p: EmbedProgress) => void): Promise<any> {
  if (!extractorP) {
    extractorP = (async () => {
      onProgress?.({ phase: "runtime", label: "loading model runtime…" });
      const t: any = await import(/* @vite-ignore */ CDN);
      // let onnxruntime-web fetch its wasm from the same CDN (no local asset wiring needed)
      if (t.env?.backends?.onnx?.wasm) t.env.backends.onnx.wasm.wasmPaths = CDN + "/dist/";
      return t.pipeline("feature-extraction", id, {
        // transformers.js streams {status, file, progress 0..100, loaded, total} while it pulls the ~23MB weights.
        progress_callback: (e: any) => {
          if (!onProgress) return;
          if (e?.status === "progress" && typeof e.progress === "number") onProgress({ phase: "download", pct: Math.round(e.progress), label: `downloading model ${Math.round(e.progress)}%` });
          else if (e?.status === "done" || e?.status === "ready") onProgress({ phase: "download", pct: 100, label: "model ready" });
        },
      });
    })().catch((err) => { extractorP = null; throw err; });
  }
  return extractorP;
}

// Drop the cached model so the next embed re-fetches from scratch (called after a stall/abort, for a clean retry).
export function resetEmbedder(): void { extractorP = null; }

// Embed one query → unit-normalized Float32Array (384 dims for MiniLM). Reports load/embed progress if asked.
export async function embedQuery(text: string, embedderId = "Xenova/all-MiniLM-L6-v2", onProgress?: (p: EmbedProgress) => void): Promise<Float32Array> {
  const ex = await extractor(embedderId, onProgress);
  onProgress?.({ phase: "embed", label: "embedding query…" });
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
// (scale100/rankNorm100 removed — the registry's scores01 in dimensions.ts owns raw→0..100 for every dimension,
// query axes included, applying the per-dimension norm/invert props uniformly.)
