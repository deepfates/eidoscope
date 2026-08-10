#!/usr/bin/env bun
// Re-measure the kNN regime costs on THIS machine (reference: apple metal-3, 2026-08 — exact-GPU won
// at every benched n: 10k/100k/230k; the numbers live in src/knn/regime.ts's header comment). The
// regime branch is environment-only (adapter or not) — there is no crossover constant to tune; run
// this after a hardware change to check the "GPU wins everywhere we measured" claim still holds, and
// update the regime.ts comment if the picture changes.
//
//   bun bin/knn-calibrate.ts [nGpu=30000] [nHnsw=10000]
import { knnExact } from "../src/geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "../src/knn/kernel.ts";
import { knnIndex, nodeGpu } from "../src/map.ts";
import { hnswWasmKnn } from "../vendor/hnswlib-wasm/hnsw.ts";
import { SEED } from "../src/axes.ts";
import { strictRecall } from "../src/knn/recall.ts";

const D = 384, K = 14; // eidoscope layout params (MiniLM dim, UMAP nNeighbors-1)
const nGpu = parseInt(process.argv[2] ?? "30000", 10), nHnsw = parseInt(process.argv[3] ?? "10000", 10);

const mb = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// CLUSTERED vectors, same generator as test/knn.test.ts — calibrated ef is data-dependent, so the
// cost curve must be measured on structured data like real card embeddings, not uniform noise
const make = (n: number, seed = 7) => {
  const rnd = mb(seed);
  const centers = Array.from({ length: 8 }, () => Array.from({ length: D }, () => (rnd() - 0.5) * 2));
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % 8], v = c.map((x) => x + (rnd() + rnd() + rnd() - 1.5) * 0.6);
    const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / s);
  });
};
const time = async <T>(f: () => Promise<T> | T) => { const t0 = performance.now(); await f(); return (performance.now() - t0) / 1000; };

console.error(`generating ${Math.max(nGpu, nHnsw)} x ${D} vectors…`);
const Xbig = make(Math.max(nGpu, nHnsw));
const Xg = Xbig.slice(0, nGpu), Xh = Xbig.slice(0, nHnsw);

const gpu = await nodeGpu();
let A = NaN;
if (await gpuAdapterFor(gpu, nGpu, D)) {
  // measure twice, keep the WORSE run — the documented ~20% run-to-run GPU variance
  const t = Math.max(await time(() => exactGpuKnn(gpu!, Xg, K)), await time(() => exactGpuKnn(gpu!, Xg, K)));
  A = t / (nGpu * nGpu);
  console.log(`exact-gpu   @ ${nGpu}: ${t.toFixed(2)}s  → A = ${A.toExponential(3)} s/n²`);
} else console.log("exact-gpu: no WebGPU adapter on this host");

const tNat = await time(() => knnIndex(Xh, K));
console.log(`hnsw-native @ ${nHnsw}: ${tNat.toFixed(2)}s (build + ef calibration + calibrated query pass)`);
const tWasm = await time(() => hnswWasmKnn(Xh, K, SEED));
console.log(`hnsw-wasm   @ ${nHnsw}: ${tWasm.toFixed(2)}s`);

// tiny sanity: both index paths still answer neighbors correctly on a small slice
const Xs = Xbig.slice(0, 800);
const e = await knnExact(Xs, K), nat = knnIndex(Xs, K);
console.log(`sanity recall (hnsw-native vs exact, n=800): ${strictRecall(nat.idx, e.idx, K).toFixed(4)}`);
