#!/usr/bin/env bun
// Re-measure the kNN regime cost curves on THIS machine and compare against the constants baked into
// src/knn/regime.ts (measured on apple metal-3, 2026-08). Run after a hardware change or when the
// regime choice looks wrong: if the printed coefficients drift far from the baked ones, update
// regime.ts with the new measurements (they are documented constants, not tunables).
//
//   bun bin/knn-calibrate.ts [nGpu=30000] [nHnsw=10000]
import { knnExact } from "../src/geometry.ts";
import { gpuAdapterFor, exactGpuKnn } from "../src/knn/kernel.ts";
import { knnIndex, nodeGpu } from "../src/map.ts";
import { hnswWasmKnn } from "../vendor/hnswlib-wasm/hnsw.ts";
import { SEED } from "../src/axes.ts";
import { exactGpuCrossover, GPU_SECONDS_PER_N2, HNSW_SECONDS_PER_NLOGN_NATIVE, HNSW_SECONDS_PER_NLOGN_WASM } from "../src/knn/regime.ts";

const D = 384, K = 14; // eidoscope layout params (MiniLM dim, UMAP nNeighbors-1)
const nGpu = parseInt(process.argv[2] ?? "30000", 10), nHnsw = parseInt(process.argv[3] ?? "10000", 10);

const mb = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rnd = mb(7);
const make = (n: number) => Array.from({ length: n }, () => { const v = Array.from({ length: D }, () => rnd() - 0.5); const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return v.map((x) => x / s); });
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
  console.log(`exact-gpu   @ ${nGpu}: ${t.toFixed(2)}s  → A = ${A.toExponential(3)} s/n²   (baked: ${GPU_SECONDS_PER_N2.toExponential(3)})`);
} else console.log("exact-gpu: no WebGPU adapter on this host");

const tNat = await time(() => knnIndex(Xh, K));
const Bn = tNat / (nHnsw * Math.log2(nHnsw));
console.log(`hnsw-native @ ${nHnsw}: ${tNat.toFixed(2)}s → B = ${Bn.toExponential(3)} s/(n·log2 n) (baked: ${HNSW_SECONDS_PER_NLOGN_NATIVE.toExponential(3)})`);
const tWasm = await time(() => hnswWasmKnn(Xh, K, SEED));
const Bw = tWasm / (nHnsw * Math.log2(nHnsw));
console.log(`hnsw-wasm   @ ${nHnsw}: ${tWasm.toFixed(2)}s → B = ${Bw.toExponential(3)} s/(n·log2 n) (baked: ${HNSW_SECONDS_PER_NLOGN_WASM.toExponential(3)})`);
console.log(`crossover (baked curves):  native ${exactGpuCrossover(HNSW_SECONDS_PER_NLOGN_NATIVE).toLocaleString()} docs · wasm ${exactGpuCrossover(HNSW_SECONDS_PER_NLOGN_WASM).toLocaleString()} docs`);

// tiny sanity: both index paths still answer neighbors correctly on a small slice
const Xs = Xbig.slice(0, 800);
const e = await knnExact(Xs, K), nat = knnIndex(Xs, K);
let hit = 0, tot = 0;
for (let i = 0; i < Xs.length; i++) { const t = new Set(e.idx[i].slice(1)); for (const j of nat.idx[i].slice(1)) { tot++; if (t.has(j)) hit++; } }
console.log(`sanity recall (hnsw-native vs exact, n=800): ${(hit / tot).toFixed(4)}`);
