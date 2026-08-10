// The semantic-query primitive (the keystone). Embed a free-text query IN THE BROWSER with the SAME model
// that made the carried card vectors (Xenova/all-MiniLM-L6-v2, pooling mean, normalized) — proven in Node to
// rank the real corpus sensibly — then cosine-rank every card. The per-card scalar becomes a synthetic AXIS,
// so it flows through the existing channel grammar (color / size / x / y) with no per-channel wiring.
//
// The embedder lives in the APP (never the file): transformers.js is lazy-loaded from a CDN on first query
// (~small js; the MiniLM weights ~23MB stream from the HF hub once, then cache). This matches the architecture
// — the .eido carries the vectors (the value); the app carries the runtime. The embedder id is pinned to the
// file's derivedBy.embedder.id so a query lands in the SAME space as the cards.

import type { CardVectors } from "../../src/schema";

// Test seam (same spirit as window.__eido): the integration suite serves the runtime + weights from
// localhost so an ingest e2e is hermetic — production never sets these and uses the CDN + HF hub.
const CDN = (globalThis as any).__EIDO_TF_CDN ?? "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
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
      const host = (globalThis as any).__EIDO_TF_HOST;
      if (host && t.env) { t.env.remoteHost = host; t.env.allowLocalModels = false; }
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

// ── BATCH EMBEDDING for the in-page ingest (eid-bacg) ────────────────────────────────────────────────
// The SAME extractor/model as queries, batched — chunk texts arrive from geometry.poolEmbedWith, so the
// chunking/pooling discipline is the shared implementation, and only the raw "strings → vectors" step
// lives here. Chunks are content-addressed (geometry hashes text+len into the id), cached in a
// session-memory map AND, when the caller passes one, a persistent Store (viewer/src/opfs.ts — the
// browser twin of the node fulltext/card embedding caches, one file per model): a retried pass, a
// resumed run, or a reopened tab re-embeds nothing it already embedded. When everything hits, the
// extractor (and its ~23MB model download) is never even loaded.
type EmbedStore = { get(k: string): any; put(k: string, v: any): void };
const embCache = new Map<string, number[]>();
export async function embedItems(
  items: { id: string; text: string }[],
  embedderId = "Xenova/all-MiniLM-L6-v2",
  onProgress?: (done: number, total: number) => void,
  batch = 16,
  onModel?: (p: EmbedProgress) => void,
  cache?: EmbedStore,
): Promise<number[][]> {
  const out: (number[] | null)[] = items.map((it) => embCache.get(it.id) ?? (cache?.get(it.id) as number[] | undefined) ?? null);
  const misses = items.map((it, i) => ({ it, i })).filter((x) => out[x.i] === null);
  let done = items.length - misses.length;
  onProgress?.(done, items.length);
  if (!misses.length) return out as number[][];
  const ex = await extractor(embedderId, onModel);
  for (let b = 0; b < misses.length; b += batch) {
    const chunk = misses.slice(b, b + batch);
    const res: any = await ex(chunk.map((m) => m.it.text || " "), { pooling: "mean", normalize: true });
    const arr: number[][] = res.tolist();
    chunk.forEach((m, j) => { out[m.i] = arr[j]; embCache.set(m.it.id, arr[j]); cache?.put(m.it.id, arr[j]); });
    done += chunk.length;
    onProgress?.(done, items.length);
    await new Promise((r) => setTimeout(r, 0));   // yield so the progress UI actually paints
  }
  return out as number[][];
}
