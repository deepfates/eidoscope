// Minimal C wrapper over upstream hnswlib (header-only C++) for the wasm build — see build.sh for
// provenance (pinned upstream commit) and flags. One index at a time, matching eidoscope's usage
// (src/map.ts knnIndex builds, queries, and discards). InnerProductSpace on UNIT vectors == the
// "cosine" space hnswlib-node uses (distance = 1 - dot); geometry.ts normalizes before the seam.
#include <emscripten.h>
#include "hnswlib/hnswlib.h"

static hnswlib::InnerProductSpace* g_space = nullptr;
static hnswlib::HierarchicalNSW<float>* g_index = nullptr;

extern "C" {

EMSCRIPTEN_KEEPALIVE void hnsw_init(int dim, int maxElements, int M, int efConstruction, int seed) {
  delete g_index; delete g_space;
  g_space = new hnswlib::InnerProductSpace(dim);
  g_index = new hnswlib::HierarchicalNSW<float>(g_space, maxElements, M, efConstruction, seed);
}

EMSCRIPTEN_KEEPALIVE void hnsw_set_ef(int ef) { g_index->setEf(ef); }

EMSCRIPTEN_KEEPALIVE void hnsw_add(const float* v, int label) { g_index->addPoint(v, (hnswlib::labeltype)label); }

// top-k by ascending distance into outLabels/outDists; returns how many were found (≤ k)
EMSCRIPTEN_KEEPALIVE int hnsw_search(const float* q, int k, unsigned* outLabels, float* outDists) {
  auto res = g_index->searchKnn(q, (size_t)k);
  int n = (int)res.size();
  for (int i = n - 1; i >= 0; i--) { outDists[i] = res.top().first; outLabels[i] = (unsigned)res.top().second; res.pop(); }
  return n;
}

EMSCRIPTEN_KEEPALIVE void hnsw_free() { delete g_index; g_index = nullptr; delete g_space; g_space = nullptr; }

}
