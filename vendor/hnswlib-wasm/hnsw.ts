// TS face of the vendored hnswlib wasm build (see build.sh for provenance). Mirrors src/map.ts
// knnIndex exactly — same params (M=16, efConstruction=200, seeded level RNG, sequential insertion,
// ef calibrated per index via src/knn/ef.ts), same SELF-INCLUSIVE output rows with sqrt(2·cosineDist)
// distances — because it IS
// the same algorithm over the same upstream headers; only the compiler differs. Deterministic for the
// same input; per-row neighbor SETS verified identical to hnswlib-node (order can swap where f32
// distances tie — measured 2/4000 rows on clustered data) and recall ≥ 0.99 vs exact (test/knn.test.ts).
// X must be unit vectors (InnerProductSpace distance = 1 - dot = cosine distance on the unit sphere).
// @ts-ignore -- generated emscripten module (no types; the surface is 5 C functions)
import createHnswModule from "./hnswlib.mjs";
import { calibrateEf } from "../../src/knn/ef.ts";

let modP: Promise<any> | null = null;
const mod = () => (modP ??= createHnswModule());

export async function hnswWasmKnn(X: number[][], K: number, seed: number): Promise<{ idx: number[][]; dst: number[][] }> {
  const m = await mod();
  const n = X.length, dim = X[0].length, Kc = Math.min(K, n - 1);
  m._hnsw_init(dim, n, 16, 200, seed);
  const vPtr = m._malloc(dim * 4);
  const outL = m._malloc((Kc + 1) * 4), outD = m._malloc((Kc + 1) * 4);
  try {
    for (let i = 0; i < n; i++) {
      m.HEAPF32.set(X[i], vPtr >> 2);
      m._hnsw_add(vPtr, i);
    }
    // ef CALIBRATED per index against sampled exact truth (src/knn/ef.ts) — see map.ts knnIndex
    const searchAt = (i: number, k: number, ef: number): number[] => {
      m._hnsw_set_ef(Math.max(ef, k + 1));
      m.HEAPF32.set(X[i], vPtr >> 2);
      const got = m._hnsw_search(vPtr, Math.min(n, k + 1), outL, outD);
      const labels = m.HEAPU32.subarray(outL >> 2, (outL >> 2) + got);
      const out: number[] = [];
      for (let t = 0; t < got && out.length < k; t++) if (labels[t] !== i) out.push(labels[t]);
      return out;
    };
    const { ef } = calibrateEf(X, Kc, searchAt);
    m._hnsw_set_ef(Math.max(ef, Kc + 1));
    const idx: number[][] = [], dst: number[][] = [];
    for (let i = 0; i < n; i++) {
      m.HEAPF32.set(X[i], vPtr >> 2);
      const got = m._hnsw_search(vPtr, Math.min(n, Kc + 1), outL, outD);
      const labels = m.HEAPU32.subarray(outL >> 2, (outL >> 2) + got);
      const dists = m.HEAPF32.subarray(outD >> 2, (outD >> 2) + got);
      const pairs: [number, number][] = [];
      for (let t = 0; t < got; t++) if (labels[t] !== i) pairs.push([labels[t], dists[t]]);
      const top = pairs.slice(0, Kc);
      idx.push([i, ...top.map(([j]) => j)]);
      dst.push([0, ...top.map(([, d]) => Math.sqrt(Math.max(0, 2 * d)))]);
    }
    return { idx, dst };
  } finally {
    m._free(vPtr); m._free(outL); m._free(outD); m._hnsw_free();
  }
}
