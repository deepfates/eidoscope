// THE kNN REGIME CHOOSER — one host-free function that picks which implementation answers the seam.
// The branch is on ENVIRONMENT, never on data scale: there is no crossover constant (owner ruling,
// 2026-08 — an earlier draft solved an extrapolated fixed point at ~2.1M docs and let it steer the
// choice; that was a mode with a magic number, and it is deleted, not relabeled).
//
// Two regimes:
//   exact  — the WebGPU brute-force kernel (src/knn/kernel.ts): recall 1.0 by construction. O(n²·d),
//            but so wide on a GPU that it MEASURED faster than hnsw at every benched size
//            (10k / 100k / 230k × 384, apple metal-3, 2026-08: 0.19–0.27s · 23.7–23.9s · 162s vs
//            hnsw-native 27.3s @ 10k including ef calibration). Beyond the benched range no
//            measurement says otherwise, and recall 1.0 breaks the tie. The with-GPU regime.
//   hnsw   — hnswlib (node: hnswlib-node addon; page: vendor/hnswlib-wasm): O(n·log n) build,
//            recall ≥ 0.99 held by per-index ef calibration (src/knn/ef.ts). hnsw exists for
//            machines without WebGPU — and catches corpora the adapter's buffer limits reject,
//            and kernel failures. bin/knn-calibrate.ts re-measures both curves on new hardware.
import { knnExact, type Knn, type KnnResult, HNSW_MIN } from "../geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "./kernel.ts";

export type RegimeOpts = {
  // the host's GPU entry point (browser: navigator.gpu; node: the `webgpu` Dawn package) — null = none
  gpu?: GPU | null;
  // the host's hnsw implementation in seam shape (without `method`) — absent = exact only
  hnsw?: (X: number[][], K: number) => Promise<Omit<KnnResult, "method">> | Omit<KnnResult, "method">;
  hnswMethod?: string;                 // provenance name: "hnswlib-node" | "hnswlib-wasm"
};

// The regime chooser IS the seam implementation hosts inject into projectAndCluster.
export function makeKnn(o: RegimeOpts): Knn {
  const hnsw = o.hnsw
    ? async (X: number[][], K: number): Promise<KnnResult> => ({ ...(await o.hnsw!(X, K)), method: o.hnswMethod ?? "hnsw" })
    : null;
  return async (X, K) => {
    const n = X.length;
    // Under HNSW_MIN every host answers with the SAME CPU brute force: it's exact, cheap at this size
    // (device setup would eat most of a GPU win), and it keeps a page-built and a CLI-built map of the
    // same small corpus bit-identical (test/ingest.test.ts parity) instead of float-order-different.
    if (n <= HNSW_MIN) return knnExact(X, K);
    const adapter = await gpuAdapterFor(o.gpu, n, X[0]?.length ?? 0); // adapter present AND big enough for this n
    if (adapter) {
      try { return { ...(await exactGpuKnn(o.gpu!, X, K)), method: "exact-gpu" }; } // kernel re-requests (adapters are single-use)
      catch (e) { console.error(`exact-gpu kNN failed (${e}) — falling back`); }
    }
    if (hnsw) return hnsw(X, K);
    return knnExact(X, K); // no GPU, no index — exact CPU is the only honest answer left (slow, never wrong)
  };
}
