// The PAGE face of the kNN seam (src/knn/regime.ts holds the regime logic and the measurements):
// exact WebGPU whenever the browser exposes a working adapter (recall 1.0 — GPU won at every
// benched n), the vendored hnswlib wasm build without a GPU past HNSW_MIN,
// CPU brute force for small corpora. Same seam shape as the node face (src/map.ts nodeKnn), so a
// page-built map and a CLI-built map record the same derivedBy.neighbors vocabulary.
import type { Knn } from "../../src/geometry";
import { SEED } from "../../src/axes";
import { makeKnn } from "../../src/knn/regime";
import { hnswWasmKnn } from "../../vendor/hnswlib-wasm/hnsw";

export const pageKnn: Knn = (X, K) =>
  makeKnn({
    gpu: typeof navigator !== "undefined" ? navigator.gpu ?? null : null,
    hnsw: (x, k) => hnswWasmKnn(x, k, SEED),
    hnswMethod: "hnswlib-wasm",
  })(X, K);
