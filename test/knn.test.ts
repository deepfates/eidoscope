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
import { rowDefects, strictRecall } from "../src/knn/recall.ts";

// GPU availability decided ONCE, up front: a receipt that cannot run must be a SKIPPED test, never a
// silent pass (adversarial-review finding — the production gate false-greened on non-GPU CI in 0.04ms)
const _gpu = await nodeGpu();
const hasGpuSmall = !!(await gpuAdapterFor(_gpu, 4000, 64));
const hasGpuProd = !!(await gpuAdapterFor(_gpu, 30000, 384));

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
// STRICT recall lives in ONE shared module (src/knn/recall.ts) used by these tests AND the browser
// probe — a parallel copy is how a forgiving denominator survived one review round.
const assertRows = (rows: number[][], n: number, K: number) => expect(rowDefects(rows, n, K)).toBe(0);
const recall = strictRecall;

const K = 14; // eidoscope's UMAP graph K (nNeighbors 15, self-inclusive)
const dot = (a: number[], b: number[]) => { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; };

test.skipIf(!hasGpuSmall)("exact-gpu kNN IS the exact answer (recall 1.0 up to f32 ties) and its distances match CPU brute force (skips without a WebGPU adapter)", async () => {
  const gpu = await nodeGpu();
  const X = clustered(4000, 64);
  const g = await exactGpuKnn(gpu!, X, K);
  const e = await knnExact(X, K);
  // every GPU neighbor must be a true top-K member OR tied with the K-th at f32 precision (the kernel
  // accumulates in f32, the CPU truth in f64 — on clustered data near-ties can swap at the boundary)
  for (let i = 0; i < X.length; i++) {
    const truth = new Set(e.idx[i].slice(1));
    const kth = dot(X[i], X[e.idx[i][K]]);
    for (const j of g.idx[i].slice(1)) if (!truth.has(j)) expect(Math.abs(dot(X[i], X[j]) - kth)).toBeLessThan(1e-5);
  }
  assertRows(g.idx, X.length, K);
  expect(recall(g.idx, e.idx, K)).toBeGreaterThan(0.9999);
  for (let i = 0; i < X.length; i += 97) g.dst[i].forEach((d, m) => expect(Math.abs(d - e.dst[i][m])).toBeLessThan(1e-4));
}, 60000);

test("hnswlib wasm ≡ hnswlib-node per-row neighbor SETS at identical params, and both ≥ 0.99 recall vs exact", async () => {
  const X = clustered(4000, 64);
  const e = await knnExact(X, K);
  const nat = knnIndex(X, K);
  const wasm = await hnswWasmKnn(X, K, SEED);
  // same upstream headers, same seed, same insertion order → same graph; measured: identical rows on
  // uniform data, and on clustered data only ORDER can swap where f32 distances tie (2/4000 rows) —
  // so the honest invariant is per-row SET equality, asserted BOTH ways with equal lengths
  assertRows(nat.idx, X.length, K);
  assertRows(wasm.idx, X.length, K);
  for (let i = 0; i < X.length; i++) {
    expect(wasm.idx[i].length).toBe(nat.idx[i].length);
    const a = new Set(nat.idx[i]), b = new Set(wasm.idx[i]);
    expect(wasm.idx[i].every((j) => a.has(j))).toBe(true);
    expect(nat.idx[i].every((j) => b.has(j))).toBe(true);
  }
  expect(recall(nat.idx, e.idx, K)).toBeGreaterThanOrEqual(0.99);
  expect(recall(wasm.idx, e.idx, K)).toBeGreaterThanOrEqual(0.99);
}, 120000);

// THE PRODUCTION-SCALE GATE (adversarial-review P1): at 30k×384 — real corpus scale, real embedding
// dimension — a fixed ef=64 measured recall 0.933; the per-index ef calibration (src/knn/ef.ts) must
// bring BOTH hnsw builds back over the 0.99 claim against exact truth. Truth comes from the exact GPU
// kernel (recall 1.0, itself gated above); without a GPU this receipt is a SKIPPED test, never a pass.
test.skipIf(!hasGpuProd)("PRODUCTION SCALE: hnsw recall ≥ 0.99 at n=30k, d=384, K=14 (calibrated ef) vs exact truth (skips without a WebGPU adapter)", async () => {
  const gpu = await nodeGpu();
  const X = clustered(30000, 384);
  const truth = await exactGpuKnn(gpu!, X, K);
  const nat = knnIndex(X, K);
  assertRows(nat.idx, X.length, K);
  const rNat = recall(nat.idx, truth.idx, K);
  const wasm = await hnswWasmKnn(X, K, SEED);
  assertRows(wasm.idx, X.length, K);
  const rWasm = recall(wasm.idx, truth.idx, K);
  console.log(`    production-scale recall @30k×384 K=14: native ${rNat.toFixed(4)} · wasm ${rWasm.toFixed(4)}`);
  expect(rNat).toBeGreaterThanOrEqual(0.99);
  expect(rWasm).toBeGreaterThanOrEqual(0.99);
}, 900000);

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
