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
//   hnsw native:      12.0s @ 10k · 55.2s @ 30k          (single-threaded build dominates)
//   hnsw wasm:        15.3s @ 10k · 71.2s @ 30k          (1.29× native — same headers, no threads)
// Fits: t_exact(n) ≈ A·n² with A from the LARGEST measured n (162/230k² = 3.06e-9 s — conservative
// against the GPU, absorbing its slightly superlinear bandwidth tail); t_hnsw(n) ≈ B·n·log2(n) with
// B_native = 55.2/(30k·log2 30k) = 1.24e-4 s, B_wasm = 1.29×that.
// The crossover is the fixed point of A·n² = H·B·n·log2(n) → n = (H·B/A)·log2(n), with H = 1.5
// hysteresis so the ~20% run-to-run GPU variance we measured can never flap the choice. On this
// hardware class that solves to ≈ 1.2M docs (native B) — i.e. WITH a GPU, exact neighbors win the
// whole practical range; hnsw is the no-GPU regime and the guard beyond ~a million docs.
import { knnExact, type Knn, type KnnResult, HNSW_MIN } from "../geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "./kernel.ts";

export const GPU_SECONDS_PER_N2 = 3.06e-9;     // measured: 162s @ n=230k (worst of 3 points)
export const HNSW_SECONDS_PER_NLOGN_NATIVE = 1.24e-4; // measured: 55.2s @ n=30k, hnswlib-node
export const HNSW_SECONDS_PER_NLOGN_WASM = 1.6e-4;    // measured: 71.2s @ n=30k, vendored wasm
const HYSTERESIS = 1.5; // > the ~20% GPU run-to-run variance — the boundary can't flap on noise

// Solve n = (H·B/A)·log2(n) by fixed-point iteration (converges in a handful of steps for any B/A > 0).
export function exactGpuCrossover(hnswSecondsPerNLogN: number): number {
  const c = (HYSTERESIS * hnswSecondsPerNLogN) / GPU_SECONDS_PER_N2;
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
