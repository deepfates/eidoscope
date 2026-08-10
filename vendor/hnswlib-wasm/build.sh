#!/bin/bash
# Build the vendored hnswlib wasm module (hnswlib.mjs, committed) from the LIVING upstream.
#
#   upstream: github.com/nmslib/hnswlib (header-only C++)
#   pinned commit: d9b3608c83d83b46c96e25088cb1d729b29dcfe9  (master, 2026-08)
#   license: Apache-2.0 — the upstream license is committed as LICENSE.hnswlib in this directory and
#   MUST travel with any distribution that carries the built artifact (the npm files list includes
#   vendor/; the single-file viewer embeds the wasm, so the notice ships with the repo it came from)
#
# The npm wrapper ecosystem for hnswlib-in-the-browser is dead (hnswlib-wasm's last release crashed
# our runtime via its -lidbfs.js persistence hooks), so we build our own from wrapper.cpp — a ~30 line
# C API over the upstream headers, modeled on that wrapper's makefile but: no idbfs, no ASSERTIONS,
# no sourcemaps, SINGLE_FILE (wasm embedded as base64 → survives the offline single-file viewer
# export), and ENVIRONMENT=web,worker,node so the same artifact runs in the page AND under bun tests.
# The built hnswlib.mjs is COMMITTED — contributors never need emcc; this script is only for rebuilds
# (toolchain: `brew install emscripten`, emcc 6.x).
#
# Same algorithm as hnswlib-node (both wrap these headers): at identical params (M, efConstruction,
# ef, seed, insertion order) the wasm build's neighbors were verified bit-identical to the native
# addon's. test/knn.test.ts holds the recall gate (≥0.99 at eidoscope params).
set -euo pipefail
cd "$(dirname "$0")"

COMMIT=d9b3608c83d83b46c96e25088cb1d729b29dcfe9
if [ ! -d hnswlib-src ]; then
  git clone https://github.com/nmslib/hnswlib hnswlib-src
fi
git -C hnswlib-src fetch -q origin "$COMMIT" || true
git -C hnswlib-src checkout -q "$COMMIT"

em++ -O3 \
  -sWASM=1 -sSINGLE_FILE=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHnswModule \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -sENVIRONMENT=web,worker,node -sDYNAMIC_EXECUTION=0 \
  -sEXPORTED_FUNCTIONS=_hnsw_init,_hnsw_set_ef,_hnsw_add,_hnsw_search,_hnsw_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU32 \
  -Ihnswlib-src \
  wrapper.cpp -o hnswlib.mjs

echo "built hnswlib.mjs ($(du -h hnswlib.mjs | cut -f1)) from hnswlib@$COMMIT"
