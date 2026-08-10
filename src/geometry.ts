// HOST-FREE geometry — the layout/scoring stages of the engine, shared verbatim by the node pipeline
// (src/map.ts wraps these with the kNN regimes + the on-disk embedding cache) and the in-page ingest
// (viewer/src/ingest.ts wraps them with the transformers.js embedder). Nothing here touches node APIs;
// kNN is an INJECTED seam (`Knn`) because its implementations are host-bound (Dawn vs navigator.gpu,
// hnswlib-node vs the vendored wasm) — src/knn/regime.ts chooses among them by measured cost curves.
import { UMAP } from "umap-js";
import type { Card } from "./card.ts";
import { mulberry32, SEED, type Axis } from "./axes.ts";
import { divisiveLevels } from "./cluster.ts";
import { GRAIN_PALETTE_N, type MapContract, type MetaField } from "./schema.ts";
import { EMBED_PARAMS } from "./defaults.ts";

// Declare each corpus field as a TYPED encodable dimension (the channel-grammar substrate). Presence-based:
// only emit what this corpus actually carries. The viewer resolves `source` to values; we just declare types.
export function buildMetaFields(D: Partial<MapContract> & { axes: MapContract["axes"] }): MetaField[] {
  const has = (a?: unknown[]) => Array.isArray(a) && a.some((x) => x != null && x !== "");
  const f: MetaField[] = [];
  if (has(D.authors)) f.push({ key: "author", label: "author", type: "categorical", source: "col:authors" });
  if (has(D.siteNames)) f.push({ key: "site", label: "source site", type: "categorical", source: "col:siteNames" });
  // prefer the carried folders column; the url-derived fallback only works for file:// urls (old files)
  if (has(D.folders)) f.push({ key: "folder", label: "folder", type: "categorical", source: "col:folders" });
  else if (Array.isArray(D.urls) && D.urls.some((u) => typeof u === "string" && u.startsWith("file://"))) f.push({ key: "folder", label: "folder", type: "categorical", source: "derived:folder" });
  if (has(D.tags)) f.push({ key: "tags", label: "tag", type: "categorical", multi: true, source: "col:tags" });
  if (has(D.dates)) f.push({ key: "date", label: "date", type: "temporal", source: "col:dates" });
  if (has(D.read)) f.push({ key: "read", label: "read", type: "boolean", source: "col:read" });
  f.push({ key: "hub", label: "connections", type: "scalar", source: "col:hub" });
  if (has(D.citec)) f.push({ key: "citec", label: "citation impact", type: "scalar", source: "col:citec" });
  f.push({ key: "length", label: "length", type: "scalar", source: "derived:length" });
  for (const a of D.axes) f.push({ key: "axis:" + a.key, label: a.name, type: "scalar", source: "axis:" + a.key });
  return f;
}

// The human-readable full card: title + restatement + every axis placement, concatenated into ONE
// string. This is also exactly what the map geometry embeds — building the maps three ways and LOOKING
// settled it: the combined card stays cleanly structured. Both parts are the LLM card — no full-text,
// no PCA in the geometry.
export const cardText = (c: Card, axes: Axis[]) => (c.title ? c.title + ". " : "") + (c.core || "") + " " + axes.map((a) => c.axes[a.key]?.note || "").filter(Boolean).join(". ");

// Calibrated axis positions straight from the deterministic PCA projection (grug), rank-normalized to
// 0-100. REPLACES the LLM's absolute scores for positioning: the projection is continuous and
// comparative by construction, where the model saturates and buckets. The LLM's notes still feed the map.
export function projectionScores(projections: number[][], axes: { key: string; pc: number }[]): Record<string, number[]> {
  const n = projections.length;
  const rank = (col: number[]) => {
    const order = col.map((_, i) => i).sort((i, j) => col[i] - col[j]);
    const out = new Array<number>(n);
    order.forEach((oi, r) => { out[oi] = n > 1 ? Math.round((100 * r) / (n - 1)) : 50; });
    return out;
  };
  return Object.fromEntries(axes.map((a) => [a.key, rank(projections.map((row) => row[a.pc - 1]))]));
}

// The SAME PCA projections without the rank step — the raw, true-magnitude coordinate on each axis. Rank
// (above) gives the readable even-spread default; raw lets the viewer show the honest skew (where docs pile
// vs. spread). Carried alongside `scores` so "honest ⇄ rank" on an axis is a real toggle, not a stub.
export function rawProjectionScores(projections: number[][], axes: { key: string; pc: number }[]): Record<string, number[]> {
  return Object.fromEntries(axes.map((a) => [a.key, projections.map((row) => row[a.pc - 1])]));
}

const textHash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

// Embed a batch of texts by CHUNK-POOLING: split each into word chunks (so nothing beyond the
// embedder's context window is silently dropped), embed every chunk in one batched pass, mean-pool
// back per text. The card path and the full-text path MUST use this identically — otherwise the
// card gets a single truncated pass while full text gets the whole document, an unfair asymmetry
// that also discards most of a rich card. Chunks are content-addressed (hash+len), so identical
// chunks dedupe and any change to the source text self-invalidates. `embed` is INJECTED — the node
// host passes the cached MiniLM (src/embed.ts), the page passes the transformers.js pipeline — so
// the chunking/subsampling/pooling is one implementation on both hosts.
export type EmbedItems = (items: { id: string; text: string }[]) => Promise<number[][]>;
export async function poolEmbedWith(texts: string[], embed: EmbedItems, opts: { chunkWords?: number; maxChunks?: number } = {}): Promise<number[][]> {
  const chunkWords = opts.chunkWords ?? EMBED_PARAMS.chunkWords, maxChunks = opts.maxChunks ?? EMBED_PARAMS.maxChunks;
  const items: { id: string; text: string }[] = [];
  const spans: number[][] = texts.map(() => []);
  texts.forEach((t, di) => {
    const words = (t || " ").split(/\s+/).filter(Boolean);
    let chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkWords) chunks.push(words.slice(i, i + chunkWords).join(" "));
    if (chunks.length > maxChunks) { const step = chunks.length / maxChunks, s: string[] = []; for (let i = 0; i < maxChunks; i++) s.push(chunks[Math.floor(i * step)]); chunks = s; }
    if (!chunks.length) chunks = [" "];
    chunks.forEach((text) => { spans[di].push(items.length); items.push({ id: textHash(text) + "#" + text.length, text }); });
  });
  const embs = await embed(items);
  const dim = embs[0]?.length ?? 384;
  return texts.map((_, di) => {
    const idx = spans[di], acc = new Array(dim).fill(0);
    for (const i of idx) for (let j = 0; j < dim; j++) acc[j] += embs[i][j];
    return acc.map((x) => x / (idx.length || 1));
  });
}

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

// kNN on unit vectors (cosine = dot). THE seam every layout goes through: umap-js's internal
// nn-descent path is dead here — measured recall 0.36 @ 10k / 0.15 @ 50k against exact truth, i.e. it
// was quietly poisoning browser-built maps — so projectAndCluster ALWAYS hands UMAP a precomputed
// graph from a Knn implementation. The choice is environment-only (src/knn/regime.ts): exact GPU
// whenever a WebGPU adapter is present (src/knn/kernel.ts, recall 1.0 by construction), CPU brute
// force under HNSW_MIN, and hnswlib without a GPU (node: hnswlib-node in src/map.ts; page: our
// vendored wasm build in viewer/src/knn.ts — same algorithm, verified bit-identical at identical params).
// `method` names which implementation answered — it flows into derivedBy.neighbors (provenance).
export const HNSW_MIN = 3000; // max n where O(n²·d) CPU brute force stays affordable (no-GPU fallback bound)
// Self-inclusive rows ([i, ...K neighbors]) + matching euclidean-on-the-unit-sphere distances
// (sqrt(2·cosineDist)) — the exact (indices, distances) shape umap-js's setPrecomputedKNN expects.
export type KnnResult = { idx: number[][]; dst: number[][]; method: string };
export type Knn = (X: number[][], K: number) => Promise<KnnResult> | KnnResult;

// CPU exact brute force in seam shape — the default Knn and the ground truth the others are tested against.
export const knnExact: Knn = (X, K) => {
  const n = X.length, Kc = Math.min(K, n - 1), idx: number[][] = [], dst: number[][] = [];
  for (let i = 0; i < n; i++) {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let s = 0; const a = X[i], b = X[j]; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; sims.push([j, s]); }
    sims.sort((a, b) => b[1] - a[1]);
    const top = sims.slice(0, Kc);
    idx.push([i, ...top.map(([j]) => j)]);
    dst.push([0, ...top.map(([, s]) => Math.sqrt(Math.max(0, 2 * (1 - s))))]);
  }
  return { idx, dst, method: "exact-cpu" };
};

export function knnBrute(X: number[][], K: number): number[][] {
  const n = X.length, nbr: number[][] = [];
  for (let i = 0; i < n; i++) {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let s = 0; const a = X[i], b = X[j]; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; sims.push([j, s]); }
    sims.sort((a, b) => b[1] - a[1]);
    nbr.push(sims.slice(0, K).map(([j]) => j));
  }
  return nbr;
}

// kNN in LAYOUT space (euclidean over 2–3 dims): brute for small n; past HNSW_MIN an injected l2 index
// (node) — absent one, brute still answers (the page under the envelope never gets there in practice).
export type LayoutKnnApprox = (P: number[][], K: number) => number[][];
export function layoutKnn(P: number[][], K: number, approx?: LayoutKnnApprox): number[][] {
  const n = P.length, d = P[0]?.length ?? 0, Kc = Math.min(K, n - 1);
  if (n > HNSW_MIN && approx) return approx(P, Kc);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let s = 0; for (let t = 0; t < d; t++) { const dd = P[i][t] - P[j][t]; s += dd * dd; } sims.push([j, s]); }
    sims.sort((a, b) => a[1] - b[1]);
    out.push(sims.slice(0, Kc).map(([j]) => j));
  }
  return out;
}

// THE HONESTY NUMBER for the 3D cloud (eid-ovo7): the 2D map and the 3D cloud are two INDEPENDENT UMAP
// fits of the same card vectors (same seed, same precomputed kNN graph — still different embeddings).
// This is the mean count of a card's K nearest 2D-layout neighbors that are still among its K nearest in
// the 3D layout — computed per corpus at emit time and surfaced in the about pane, so the claim
// "different arrangement" is a measured number, not vibes.
export function xyzOverlap(xy: number[][], xyz: number[][], K = 8, approx?: LayoutKnnApprox): number {
  const A = layoutKnn(xy, K, approx), B = layoutKnn(xyz, K, approx);
  let s = 0;
  for (let i = 0; i < A.length; i++) { const set = new Set(B[i]); for (const j of A[i]) if (set.has(j)) s++; }
  return A.length ? s / A.length : 0;
}

export function normPct(arr: number[][], dims: number): number[][] {
  const b = Array.from({ length: dims }, (_, j) => { const c = arr.map((r) => r[j]).sort((a, z) => a - z); const q = (p: number) => c[Math.floor(p * (c.length - 1))]; return [q(0.02), q(0.98)] as [number, number]; });
  return arr.map((r) => r.map((v, j) => +(((v - (b[j][0] + b[j][1]) / 2) / (((b[j][1] - b[j][0]) / 2) || 1))).toFixed(4)));
}

export async function projectAndCluster(embs: number[][], opts: { knn?: Knn; layoutApprox?: LayoutKnnApprox } = {}) {
  const X = embs.map(unit);
  const n = X.length;
  if (n < 5) { // too few points for UMAP/clustering — lay them on a ring so the tool still runs
    const xy = X.map((_, i) => [Math.cos((2 * Math.PI * i) / n) * 0.6, Math.sin((2 * Math.PI * i) / n) * 0.6] as number[]);
    const one = X.map(() => 0);
    return { xy, xyz: xy.map((p) => [p[0], p[1], 0]), xyzAgree: n > 1 ? Math.min(8, n - 1) : 0, cluster: one, k: 1, di: 0, levels: [one], counts: [1], hub: X.map(() => 0), nbr: X.map(() => [] as number[]), knnMethod: "none" };
  }
  const nn = Math.max(2, Math.min(15, n - 1)); // small corpora have fewer points than neighbors
  // The kNN graph is computed ONCE through the seam and ALWAYS handed to umap-js as a precomputed
  // graph. umap-js's internal nn-descent path is dead on purpose: its recall was measured at 0.36 @ 10k
  // and 0.15 @ 50k against exact truth (poisoned neighborhoods), and it was also the time AND memory
  // wall at scale (14.7GB RSS at n=100k). Default seam = exact CPU brute force; hosts inject the
  // GPU-exact / hnswlib regimes (src/map.ts, viewer/src/knn.ts).
  // Seeded: umap-js takes a `random` fn. Unseeded it draws from Math.random for init + negative sampling,
  // so the same corpus laid out twice gave different coordinates. Each fit gets its OWN generator (from the
  // same seed) so the 2D layout is unaffected by whether the 3D one ran first.
  const pre = await (opts.knn ?? knnExact)(X, nn - 1); // self-inclusive rows of length nn
  const fitUMAP = (nComponents: number) => {
    const u = new UMAP({ nComponents, nNeighbors: nn, minDist: 0.15, random: mulberry32(SEED) });
    u.setPrecomputedKNN(pre.idx, pre.dst);
    return u.fit(X);
  };
  const xy = normPct(fitUMAP(2), 2);
  const xyz = normPct(fitUMAP(3), 3);
  // GRAIN LEVELS: a nested tree of clusterings, not one arbitrary k. The viewer slides between them.
  const { levels, counts } = n < 6 ? { levels: [X.map(() => 0)], counts: [1] } : divisiveLevels(X);
  // default view = the FINEST level whose regions still fit the viewer's categorical palette without
  // recycling colours (GRAIN_PALETTE_N, shared via schema.ts) — a UI-anchored default, since the data
  // itself prefers no scale (see cluster.ts). The slider exposes the rest.
  let di = 0; counts.forEach((c, i) => { if (c <= GRAIN_PALETTE_N) di = i; });
  const cluster = levels[di] ?? X.map(() => 0), k = counts[di] ?? 1; // di = default level index; the slider exposes the rest
  // kNN + hubness (cosine on unit vectors = dot). the approximate index at scale; brute for small n.
  const K = 8, hub = new Array(n).fill(0);
  // reuse the UMAP graph's rows (nn-1 ≥ K whenever n ≥ 10); tiny corpora re-answer exactly at their smaller K
  const nbr = pre.idx[0].length - 1 >= Math.min(K, n - 1) ? pre.idx.map((row) => row.slice(1, K + 1)) : knnBrute(X, K);
  for (const top of nbr) for (const j of top) hub[j]++;
  return { xy, xyz, xyzAgree: xyzOverlap(xy, xyz, K, opts.layoutApprox), cluster, k, di, levels, counts, hub, nbr, knnMethod: pre.method };
}
