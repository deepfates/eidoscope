// The kNN regime receipts: every implementation wired behind the seam is measured against exact truth
// on synthetic-but-structured vectors (clustered, like real card embeddings — random-uniform would be
// too easy). exact-gpu must be EXACTLY the truth (recall 1.0 — it's the same math on a GPU); the
// hnswlib builds must clear 0.99 at eidoscope's params AND agree with each other bit-for-bit (wasm and
// native wrap the same upstream headers with the same seed and insertion order).
import { test, expect } from "bun:test";
import { knnExact, HNSW_MIN } from "../src/geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "../src/knn/kernel.ts";
import { makeKnn, exactGpuCrossover, HNSW_SECONDS_PER_NLOGN_NATIVE, HNSW_SECONDS_PER_NLOGN_WASM } from "../src/knn/regime.ts";
import { knnIndex, nodeGpu } from "../src/map.ts";
import { hnswWasmKnn } from "../vendor/hnswlib-wasm/hnsw.ts";
import { SEED } from "../src/axes.ts";

const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const clustered = (n: number, d: number, seed = 7) => {
  const rnd = mulberry(seed);
  const centers = Array.from({ length: 8 }, () => Array.from({ length: d }, () => (rnd() - 0.5) * 2));
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % 8], v = c.map((x) => x + (rnd() + rnd() + rnd() - 1.5) * 0.6);
    const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / s);
  });
};
const recall = (got: number[][], truth: number[][]) => {
  let hit = 0, tot = 0;
  for (let i = 0; i < got.length; i++) { const t = new Set(truth[i].slice(1)); for (const j of got[i].slice(1)) { tot++; if (t.has(j)) hit++; } }
  return hit / tot;
};

const K = 14; // eidoscope's UMAP graph K (nNeighbors 15, self-inclusive)
const dot = (a: number[], b: number[]) => { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; };

test("exact-gpu kNN IS the exact answer (recall 1.0 up to f32 ties) and its distances match CPU brute force", async () => {
  const gpu = await nodeGpu();
  const X = clustered(4000, 64);
  if (!(await gpuAdapterFor(gpu, X.length, 64))) { console.warn("⚠ no WebGPU adapter on this host — exact-gpu receipt not exercised here"); return; }
  const g = await exactGpuKnn(gpu!, X, K);
  const e = await knnExact(X, K);
  // every GPU neighbor must be a true top-K member OR tied with the K-th at f32 precision (the kernel
  // accumulates in f32, the CPU truth in f64 — on clustered data near-ties can swap at the boundary)
  for (let i = 0; i < X.length; i++) {
    const truth = new Set(e.idx[i].slice(1));
    const kth = dot(X[i], X[e.idx[i][K]]);
    for (const j of g.idx[i].slice(1)) if (!truth.has(j)) expect(Math.abs(dot(X[i], X[j]) - kth)).toBeLessThan(1e-5);
  }
  expect(recall(g.idx, e.idx)).toBeGreaterThan(0.9999);
  for (let i = 0; i < X.length; i += 97) g.dst[i].forEach((d, m) => expect(Math.abs(d - e.dst[i][m])).toBeLessThan(1e-4));
}, 60000);

test("hnswlib wasm ≡ hnswlib-node per-row neighbor SETS at identical params, and both ≥ 0.99 recall vs exact", async () => {
  const X = clustered(4000, 64);
  const e = await knnExact(X, K);
  const nat = knnIndex(X, K);
  const wasm = await hnswWasmKnn(X, K, SEED);
  // same upstream headers, same seed, same insertion order → same graph; measured: identical rows on
  // uniform data, and on clustered data only ORDER can swap where f32 distances tie (2/4000 rows) —
  // so the honest invariant is per-row set equality
  for (let i = 0; i < X.length; i++) { const a = new Set(nat.idx[i]); expect(wasm.idx[i].every((j) => a.has(j))).toBe(true); }
  expect(recall(nat.idx, e.idx)).toBeGreaterThanOrEqual(0.99);
  expect(recall(wasm.idx, e.idx)).toBeGreaterThanOrEqual(0.99);
}, 120000);

test("regime chooser: exact under HNSW_MIN on every host; crossover derived from the measured curves, GPU-variance-proof", async () => {
  // small corpora: always the shared CPU-exact answer (host parity)
  const X = clustered(200, 16);
  const viaRegime = await makeKnn({ gpu: await nodeGpu(), hnsw: knnIndex, hnswMethod: "hnswlib-node" })(X, 8);
  expect(viaRegime.method).toBe("exact-cpu");
  expect(viaRegime.idx).toEqual((await knnExact(X, 8)).idx);
  // the crossover is a solved fixed point of the measured curves, not a bare constant: it must sit far
  // above HNSW_MIN (the GPU wins the whole measured range: 10k, 100k, 230k) and respond to the curve —
  // a slower hnsw (wasm) pushes the boundary OUT, never in
  const xNative = exactGpuCrossover(HNSW_SECONDS_PER_NLOGN_NATIVE);
  const xWasm = exactGpuCrossover(HNSW_SECONDS_PER_NLOGN_WASM);
  expect(xNative).toBeGreaterThan(230000); // exact-gpu measured faster than hnsw at every benched n
  expect(xWasm).toBeGreaterThan(xNative);
  expect(HNSW_MIN).toBeLessThan(xNative);
});
