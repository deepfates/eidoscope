// The PAGE face of the kNN seam (src/knn/regime.ts holds the regime logic and the measured curves):
// exact WebGPU below the crossover when the browser exposes an adapter (navigator.gpu — feature-
// detected, recall 1.0), the vendored hnswlib wasm build above it or without a GPU past HNSW_MIN,
// CPU brute force for small corpora. Same seam shape as the node face (src/map.ts nodeKnn), so a
// page-built map and a CLI-built map record the same derivedBy.neighbors vocabulary.
import type { Knn } from "../../src/geometry";
import { SEED } from "../../src/axes";
import { makeKnn, HNSW_SECONDS_PER_NLOGN_WASM } from "../../src/knn/regime";
import { hnswWasmKnn } from "../../vendor/hnswlib-wasm/hnsw";

export const pageKnn: Knn = (X, K) =>
  makeKnn({
    gpu: typeof navigator !== "undefined" ? navigator.gpu ?? null : null,
    hnsw: (x, k) => hnswWasmKnn(x, k, SEED),
    hnswMethod: "hnswlib-wasm",
    hnswSecondsPerNLogN: HNSW_SECONDS_PER_NLOGN_WASM,
  })(X, K);
