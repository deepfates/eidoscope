// THE EMBEDDER — transformers.js bound to this origin, WORKER-SIDE ONLY (eid-yhj7 async engine): this
// module is imported by viewer/src/run.ts inside the engine Web Worker, never by the main thread, so
// model download + inference can never block a frame. (transformers.js runs in workers by design — its
// own docs ship a worker example, and WebGPU is available in Chromium workers; the adapter check below
// works identically there.) The main thread's window onto it is the engine client (viewer/src/ingest.ts).
//
// The embedder lives in the APP (never the file): transformers.js is the SAME npm package the node
// pipeline imports (@huggingface/transformers 3.8.1), bundled into the worker chunk. The MiniLM weights
// (~23MB) still stream from the HF hub once, then cache (Cache API — shared with the main thread's
// origin cache) — the .eido carries the vectors (the value); the app carries the runtime.
// The embedder id is pinned to the file's derivedBy.embedder.id so a query lands in the SAME space as the cards.
//
// Device: WebGPU when the browser actually has an adapter (the documented `device: "webgpu"` pipeline
// option). Detection is the standard WebGPU check — `navigator.gpu` plus `requestAdapter()` (MDN: null
// when no suitable adapter; the library itself detects fp16 support the same way). The adapter check
// happens BEFORE the first pipeline is created, deliberately: transformers.js caches the first session
// create as its wasm-init promise (onnx.js `wasmInitPromise ??= sessionPromise`), so a FAILED webgpu
// attempt poisons every later wasm session in the page — create-then-catch-then-retry cannot work.

let extractorP: Promise<any> | null = null;

// Progress the caller can surface while the (one-time) model download runs — so the first query isn't a
// silent 30s freeze. `pct` is 0..100 during download; `phase` distinguishes the runtime/model fetch from embed.
export type EmbedProgress = { phase: "runtime" | "download" | "embed"; pct?: number; label: string };

// Which compute backend the live extractor actually initialized on ("webgpu" | "wasm") — set once the
// pipeline resolves, so callers/tests can verify the honest device rather than trusting the feature check.
export let embedDevice: "webgpu" | "wasm" | null = null;

// The reader's device CHOICE (eid-rcm8), distinct from what got detected. "auto" asks WebGPU for an
// adapter and falls back; "wasm" declines the GPU outright. Changing it drops the cached extractor,
// because the device is bound when the pipeline is created and a stale one would silently ignore the
// choice. The vectors are the same either way — this is a speed/heat decision, not a fidelity one.
let devicePref: "auto" | "wasm" = "auto";
export function setEmbedDevice(pref: "auto" | "wasm"): void {
  if (pref === devicePref) return;
  devicePref = pref; extractorP = null; embedDevice = null;
}

// Test seam (same spirit as window.__eido): the integration suite serves the model weights and the ort
// wasm binaries from localhost so an ingest e2e is hermetic — both knobs are the library's DOCUMENTED
// env fields (env.remoteHost / env.backends.onnx.wasm.wasmPaths); production never sets these and uses
// the HF hub + the package's default wasm location.
function applyTestSeams(t: any): void {
  const host = (globalThis as any).__EIDO_TF_HOST;
  if (host && t.env) { t.env.remoteHost = host; t.env.allowLocalModels = false; }
  const wasm = (globalThis as any).__EIDO_TF_WASM;
  if (wasm && t.env?.backends?.onnx?.wasm) t.env.backends.onnx.wasm.wasmPaths = wasm;
}

// Load transformers.js + the model once. `id` should be the file's derivedBy.embedder.id. On ANY failure the
// cached promise is cleared so a retry starts clean (an aborted weights fetch shouldn't poison later tries).
async function extractor(id: string, onProgress?: (p: EmbedProgress) => void): Promise<any> {
  if (!extractorP) {
    extractorP = (async () => {
      onProgress?.({ phase: "runtime", label: "loading model runtime…" });
      const t: any = await import("@huggingface/transformers");
      applyTestSeams(t);
      const progress_callback = (e: any) => {
        if (!onProgress) return;
        if (e?.status === "progress" && typeof e.progress === "number") onProgress({ phase: "download", pct: Math.round(e.progress), label: `downloading model ${Math.round(e.progress)}%` });
        else if (e?.status === "done" || e?.status === "ready") onProgress({ phase: "download", pct: 100, label: "model ready" });
      };
      const device = await (async () => {
        if (devicePref === "wasm") return "wasm" as const;
        try { return (await (navigator as any).gpu?.requestAdapter()) ? "webgpu" as const : "wasm" as const; }
        catch { return "wasm" as const; }
      })();
      if (device === "wasm" && (navigator as any).gpu) console.warn("eidoscope: navigator.gpu present but no WebGPU adapter — embedding on wasm");
      const ex = await t.pipeline("feature-extraction", id, { device, progress_callback });
      embedDevice = device;
      return ex;
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
