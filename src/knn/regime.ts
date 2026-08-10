// THE kNN REGIME CHOOSER — one host-free function that picks which implementation answers the seam,
// by MEASURED cost curves (the grain-ladder precedent: derived, explained, visible — no bare magic n).
//
// Two regimes:
//   exact  — the WebGPU brute-force kernel (src/knn/kernel.ts): recall 1.0 by construction. O(n²·d),
//            but so wide on a GPU that it wins far beyond intuition.
//   hnsw   — hnswlib (node: hnswlib-node addon; page: vendor/hnswlib-wasm): O(n·log n) build,
//            recall ≥ 0.99 measured at our params. The above-crossover and no-GPU regime.
//
// MEASURED CURVES (apple metal-3 / M-class, 2026-08; d=384, K+1=15, the eidoscope layout params —
// harnesses: scratchpad knn-bench2 (browser) + gpu-node (node), and /tmp/hnsw-cal.ts re-run for hnsw):
//   exact-GPU total:  0.19–0.27s @ 10k · 23.7–23.9s @ 100k · 162s @ 230k   (browser ≡ node, Dawn both)
//   hnsw native:      27.3s @ 10k   (build + per-index ef calibration + calibrated query pass)
//   hnsw wasm:        33.8s @ 10k   (1.24× native — same headers, no threads)
// Fits: t_exact(n) ≈ A·n² with A from the LARGEST measured n (162/230k² = 3.06e-9 s — conservative
// against the GPU, absorbing its slightly superlinear bandwidth tail); t_hnsw(n) ≈ B·n·log2(n) with
// B_native = 27.3/(10k·log2 10k) = 2.05e-4 s, B_wasm = 2.54e-4 s. (The hnsw curve includes the ef
// calibration that holds it at ≥0.99 recall — src/knn/ef.ts; hnsw at a recall-honest ef costs about
// double the old fixed-ef=64 numbers, which pushed the boundary OUT, not in.)
// The crossover is the fixed point of A·n² = M·B·n·log2(n) → n = (M·B/A)·log2(n), where M = 1.5 is a
// STATIC EXACTNESS MARGIN: at the boundary we accept exact answers costing up to 1.5× the approximate
// ones before switching — recall 1.0 is worth a constant factor, and the margin also dwarfs the ~20%
// run-to-run GPU variance we measured (nothing here is runtime state, so nothing can flap; this is a
// bias, not hysteresis). On this hardware class the boundary solves to ≈ 2.11M docs (native B) /
// 2.66M (wasm B) — i.e. WITH a GPU, exact neighbors win the whole practical range; hnsw is the no-GPU
// regime and the guard beyond ~two million docs.
import { knnExact, type Knn, type KnnResult, HNSW_MIN } from "../geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "./kernel.ts";

export const GPU_SECONDS_PER_N2 = 3.06e-9;     // measured: 162s @ n=230k (worst of 3 points)
export const HNSW_SECONDS_PER_NLOGN_NATIVE = 2.05e-4; // measured: 27.3s @ n=10k, hnswlib-node + ef calibration
export const HNSW_SECONDS_PER_NLOGN_WASM = 2.54e-4;   // measured: 33.8s @ n=10k, vendored wasm + ef calibration
const EXACT_MARGIN = 1.5; // static bias toward exact answers at the boundary (see derivation above)

// Solve n = (M·B/A)·log2(n) by fixed-point iteration (converges in a handful of steps for any B/A > 0).
export function exactGpuCrossover(hnswSecondsPerNLogN: number): number {
  const c = (EXACT_MARGIN * hnswSecondsPerNLogN) / GPU_SECONDS_PER_N2;
  let n = Math.max(16, c);
  for (let i = 0; i < 32; i++) n = c * Math.log2(Math.max(2, n));
  return Math.round(n);
}

export type RegimeOpts = {
  // the host's GPU entry point (browser: navigator.gpu; node: the `webgpu` Dawn package) — null = none
  gpu?: GPU | null;
  // the host's hnsw implementation in seam shape (without `method`) — absent = exact only
  hnsw?: (X: number[][], K: number) => Promise<Omit<KnnResult, "method">> | Omit<KnnResult, "method">;
  hnswMethod?: string;                 // provenance name: "hnswlib-node" | "hnswlib-wasm"
  hnswSecondsPerNLogN?: number;        // which measured hnsw curve this host runs
};

// The regime chooser IS the seam implementation hosts inject into projectAndCluster.
export function makeKnn(o: RegimeOpts): Knn {
  const B = o.hnswSecondsPerNLogN ?? HNSW_SECONDS_PER_NLOGN_NATIVE;
  const hnsw = o.hnsw
    ? async (X: number[][], K: number): Promise<KnnResult> => ({ ...(await o.hnsw!(X, K)), method: o.hnswMethod ?? "hnsw" })
    : null;
  return async (X, K) => {
    const n = X.length;
    // Under HNSW_MIN every host answers with the SAME CPU brute force: it's exact, cheap at this size
    // (device setup would eat most of a GPU win), and it keeps a page-built and a CLI-built map of the
    // same small corpus bit-identical (test/ingest.test.ts parity) instead of float-order-different.
    if (n <= HNSW_MIN) return knnExact(X, K);
    const wantExact = n <= exactGpuCrossover(B) || !hnsw;
    if (wantExact) {
      const adapter = await gpuAdapterFor(o.gpu, n, X[0]?.length ?? 0); // adapter present AND big enough for this n
      if (adapter) {
        try { return { ...(await exactGpuKnn(o.gpu!, X, K)), method: "exact-gpu" }; } // kernel re-requests (adapters are single-use)
        catch (e) { console.error(`exact-gpu kNN failed (${e}) — falling back`); }
      }
    }
    if (hnsw) return hnsw(X, K);
    return knnExact(X, K); // no GPU, no index — exact CPU is the only honest answer left (slow, never wrong)
  };
}
