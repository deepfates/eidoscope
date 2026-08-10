// The NODE FACE of the geometry stages. The stage logic itself is host-free in src/geometry.ts (shared
// verbatim with the in-page ingest); this file binds it to the node host: the on-disk embedding cache,
// the local MiniLM (src/embed.ts), and the kNN regimes (exact WebGPU below the measured crossover via
// the `webgpu` Dawn package, hnswlib-node above it — src/knn/regime.ts). Existing callers keep
// importing everything from here — the re-exports below ARE the node API.
import type { Card } from "./card.ts";
import { SEED, type Axis } from "./axes.ts";
import type { Doc } from "./corpus-core.ts";
import { CFG, cachePath } from "./config.ts";
import { getTextEmbeddings, EmbeddingCache } from "./embed.ts";
import { HierarchicalNSW } from "hnswlib-node";
import {
  cardText, projectionScores, rawProjectionScores, buildMetaFields, poolEmbedWith, knnBrute, layoutKnn as layoutKnnCore,
  xyzOverlap as xyzOverlapCore, normPct, projectAndCluster as projectAndClusterCore, HNSW_MIN, type Knn, knnExact,
} from "./geometry.ts";
import { makeKnn } from "./knn/regime.ts";
import { calibrateEf } from "./knn/ef.ts";

export { cardText, projectionScores, rawProjectionScores, buildMetaFields, knnBrute, normPct, HNSW_MIN };

// Embed a batch of texts by chunk-pooling (geometry.poolEmbedWith), with the node host's content-
// addressed on-disk cache. `embed` is injectable so the chunking/pooling logic is testable without MiniLM.
export type Embedder = (items: { id: string; text: string }[], opts: { cache?: EmbeddingCache }) => Promise<number[][]>;
export async function poolEmbed(texts: string[], cacheDir: string, opts: { embed?: Embedder; chunkWords?: number; maxChunks?: number } = {}): Promise<number[][]> {
  const cache = new EmbeddingCache(cacheDir, CFG.embedModel); await cache.load();
  const embed = opts.embed ?? getTextEmbeddings;
  const out = await poolEmbedWith(texts, (items) => embed(items, { cache }), { chunkWords: opts.chunkWords ?? CFG.params.chunkWords, maxChunks: opts.maxChunks ?? CFG.params.maxChunks });
  await cache.save();
  return out;
}

// The card as the map's coordinates: one chunk-pooled embedding of the whole card text (see cardText).
export async function embedCards(cards: Card[], axes: Axis[], opts: { embed?: Embedder } = {}): Promise<number[][]> {
  return poolEmbed(cards.map((c) => cardText(c, axes)), cachePath("cache-eidoscope-cards"), opts);
}

// Full-text embedding for the generic path (when a loader has no precomputed embeddings).
export async function embedDocs(docs: Doc[], opts: { embed?: Embedder } = {}): Promise<number[][]> {
  return poolEmbed(docs.map((d) => (d.title ? d.title + ". " : "") + d.body), cachePath("cache-eidoscope-fulltext"), opts);
}

// One approximate index answers BOTH consumers: rows are SELF-INCLUSIVE ([i, ...K neighbors]) with
// matching distances converted to euclidean-on-the-unit-sphere (sqrt(2·cosineDist)) — exactly the
// (indices, distances) shape umap-js's setPrecomputedKNN expects (python UMAP convention: self counts
// as one of nNeighbors, distance 0). Callers that want plain neighbor lists slice the self column off.
// Deterministic: hnswlib's level RNG is seeded, points are inserted sequentially in corpus order, and
// search is exact given the built graph — same vectors in, same graph and neighbors out, every run.
// `recallClaim` is a TEST-ONLY override (an impossible claim forces calibration failure so the exact
// fallback below is exercisable) — production callers never pass it.
export const knnIndex = (X: number[][], K: number, recallClaim?: number): { idx: number[][]; dst: number[][] } => {
  const index = new HierarchicalNSW("cosine", X[0].length);
  index.initIndex(X.length, 16, 200, SEED);
  for (let i = 0; i < X.length; i++) index.addPoint(X[i], i);
  // ef is CALIBRATED per index against sampled exact truth (src/knn/ef.ts) — a fixed ef=64 measured
  // recall 0.933 at 30k×384, silently under the ≥0.99 claim exactly where hnsw is the map's truth
  const cal = calibrateEf(X, Math.min(K, X.length - 1), (i, k, e) => {
    index.setEf(Math.max(e, k + 1));
    return index.searchKnn(X[i], Math.min(X.length, k + 1)).neighbors.filter((j) => j !== i).slice(0, k);
  }, SEED, recallClaim);
  if (!cal.ok) {
    // the index cannot reach the recall claim even with the whole graph as candidates — never certify
    // failure: exact brute force IS affordable here (ef hit n, so n is small)
    console.error(`hnsw ef calibration failed (holdout recall ${cal.holdoutRecall.toFixed(4)} at ef=${cal.ef}) — answering with exact brute force`);
    const e = knnExact(X, K) as { idx: number[][]; dst: number[][] };
    return { idx: e.idx, dst: e.dst };
  }
  console.error(`hnsw ef calibrated: ef=${cal.ef}, holdout recall ${cal.holdoutRecall.toFixed(4)} (n=${X.length})`);
  index.setEf(Math.max(cal.ef, K + 1));
  const idx: number[][] = [], dst: number[][] = [];
  for (let i = 0; i < X.length; i++) {
    const r = index.searchKnn(X[i], Math.min(X.length, K + 1));
    const pairs = r.neighbors.map((j, t) => [j, r.distances[t]] as [number, number]).filter(([j]) => j !== i).slice(0, K);
    idx.push([i, ...pairs.map(([j]) => j)]);
    dst.push([0, ...pairs.map(([, d]) => Math.sqrt(Math.max(0, 2 * d)))]);
  }
  return { idx, dst };
};
export async function knnHNSW(X: number[][], K: number): Promise<number[][]> {
  return knnIndex(X, K).idx.map((row) => row.slice(1));
}

// hnswlib l2 in LAYOUT space (euclidean over 2–3 dims), injected past HNSW_MIN — same scale threshold,
// same determinism argument as knnIndex above.
const layoutApprox = (P: number[][], Kc: number): number[][] => {
  const n = P.length, d = P[0]?.length ?? 0;
  const index = new HierarchicalNSW("l2", d);
  index.initIndex(n, 16, 200, SEED);
  index.setEf(Math.max(64, Kc + 1));
  for (let i = 0; i < n; i++) index.addPoint(P[i], i);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(index.searchKnn(P[i], Math.min(n, Kc + 1)).neighbors.filter((j) => j !== i).slice(0, Kc));
  return out;
};
export const layoutKnn = (P: number[][], K: number): number[][] => layoutKnnCore(P, K, layoutApprox);
export const xyzOverlap = (xy: number[][], xyz: number[][], K = 8): number => xyzOverlapCore(xy, xyz, K, layoutApprox);

// NODE's GPU entry point: Dawn's own node bindings (the `webgpu` npm package, maintained by the
// Chrome WebGPU team). Optional at runtime — a machine without a usable adapter (or where the addon
// fails to load) just returns null and the regime chooser falls through to hnswlib-node. The exact
// kernel's output was verified byte-identical between this host and the browser (same Dawn underneath).
let nodeGpuP: Promise<GPU | null> | null = null;
export function nodeGpu(): Promise<GPU | null> {
  return (nodeGpuP ??= (async () => {
    try {
      const { create, globals } = await import("webgpu");
      Object.assign(globalThis, globals); // GPUBufferUsage / GPUMapMode etc. — the kernel uses the standard globals
      return create([]);
    } catch (e) { console.error(`webgpu (Dawn) unavailable on this host (${e}) — kNN falls back to hnswlib-node`); return null; }
  })());
}

// The node face of the kNN seam: exact-GPU below the measured crossover, hnswlib-node above / without
// a GPU, CPU brute force for small corpora when neither applies (src/knn/regime.ts holds the curves).
export const nodeKnn: Knn = async (X, K) =>
  makeKnn({ gpu: await nodeGpu(), hnsw: knnIndex, hnswMethod: "hnswlib-node" })(X, K);

// Project + cluster with the node host's kNN regimes wired in (geometry.ts holds the logic).
export async function projectAndCluster(embs: number[][]) {
  return projectAndClusterCore(embs, { knn: nodeKnn, layoutApprox });
}

// verify: (1) MiniLM embeds card text, (2) umap-js + curare-cluster lay out real card embeddings
if (import.meta.main) {
  const { readFileSync } = await import("node:fs");
  const { provider } = await import("./provider.ts");
  const { loadFixture, fixtureAxes } = await import("./corpus.ts");
  const { cardCorpus } = await import("./card.ts");
  const axes = fixtureAxes();
  const { docs } = loadFixture();
  const sample = docs.filter((d) => d.body.length > 2000).slice(0, 12);
  const deck = await cardCorpus(sample, axes, { llm: provider(), concurrency: 8 });
  const cardEmbs = await embedCards(deck, axes);
  console.log(`(1) embedded ${cardEmbs.length} cards -> ${cardEmbs[0].length}-dim`);

  // project the fixture's already-embedded 1350 cards (enough points for a real layout)
  const CE = JSON.parse(readFileSync((process.env.EIDOSCOPE_FIXTURE ?? ".") + "/card-embs.json", "utf8"));
  console.error(`projecting ${CE.embs.length} fixture card embeddings...`);
  const { xy, xyz, cluster, k, hub } = await projectAndCluster(CE.embs);
  const xs = xy.map((p) => p[0]);
  console.log(`(2) umap 2D: ${xy.length} pts, x∈[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}], 3D dims=${xyz[0].length}`);
  console.log(`    clusters: k=${k}, sizes=[${Array.from({ length: k }, (_, c) => cluster.filter((x) => x === c).length).join(",")}]`);
  console.log(`    hubness range ${Math.min(...hub)}–${Math.max(...hub)}`);
  const ok = cardEmbs[0]?.length === 384 && xy.length === CE.embs.length && k >= 6;
  console.log(ok ? "\n✅ embed+project stage works — MiniLM embeds, umap-js lays out, kmeans clusters" : "\n⚠ inspect");
}
