import { readFileSync } from "node:fs";
import { UMAP } from "umap-js";
import type { Card } from "./card.ts";
import { mulberry32, SEED, type Axis } from "./axes.ts";
import type { Doc } from "./corpus.ts";
import { CFG, cachePath } from "./config.ts";
import { getTextEmbeddings, EmbeddingCache } from "./embed.ts";
import { divisiveLevels } from "./cluster.ts";
import { HNSW } from "hnsw";
import type { MapContract, MetaField } from "./schema.ts";

// Declare each corpus field as a TYPED encodable dimension (the channel-grammar substrate). Presence-based:
// only emit what this corpus actually carries. The viewer resolves `source` to values; we just declare types.
export function buildMetaFields(D: Partial<MapContract> & { axes: MapContract["axes"] }): MetaField[] {
  const has = (a?: unknown[]) => Array.isArray(a) && a.some((x) => x != null && x !== "");
  const f: MetaField[] = [];
  if (has(D.authors)) f.push({ key: "author", label: "author / source", type: "categorical", source: "col:authors" });
  if (has(D.siteNames)) f.push({ key: "site", label: "source site", type: "categorical", source: "col:siteNames" });
  // prefer the carried folders column; the url-derived fallback only works for file:// urls (old files)
  if (has(D.folders)) f.push({ key: "folder", label: "folder", type: "categorical", source: "col:folders" });
  else if (Array.isArray(D.urls) && D.urls.some((u) => typeof u === "string" && u.startsWith("file://"))) f.push({ key: "folder", label: "folder", type: "categorical", source: "derived:folder" });
  if (has(D.tags)) f.push({ key: "tags", label: "tags", type: "categorical", multi: true, source: "col:tags" });
  if (has(D.dates)) f.push({ key: "date", label: "date", type: "temporal", source: "col:dates" });
  if (has(D.read)) f.push({ key: "read", label: "read", type: "boolean", source: "col:read" });
  f.push({ key: "hub", label: "influence", type: "scalar", source: "col:hub" });
  if (has(D.citec)) f.push({ key: "citec", label: "citation impact", type: "scalar", source: "col:citec" });
  f.push({ key: "length", label: "length", type: "scalar", source: "derived:length" });
  for (const a of D.axes) f.push({ key: "axis:" + a.key, label: a.name, type: "scalar", source: "axis:" + a.key });
  return f;
}

// Embed the DECK (local MiniLM) and lay it out (umap-js) — the readers' coordinates.
// Embeds the cleaned, structured card text, not the raw document: that's what de-noises the map.

// The human-readable full card: title + restatement + every axis placement, concatenated into ONE
// string. This is also exactly what the map geometry embeds (embedCards, below) — we briefly split it
// into two weighted vectors to keep the placements from drowning the restatement, but building the maps
// three ways and LOOKING settled it: the combined card stays cleanly structured, so the split was
// unnecessary machinery. Both parts are the LLM card — no full-text, no PCA in the geometry.
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
// that also discards most of a rich card. Chunks are cached content-addressed (hash+len), so identical
// chunks dedupe and any change to the source text self-invalidates.
// `embed` is injectable so the chunking/subsampling/pooling logic is testable without loading MiniLM.
export type Embedder = (items: { id: string; text: string }[], opts: { cache?: EmbeddingCache }) => Promise<number[][]>;
export async function poolEmbed(texts: string[], cacheDir: string, opts: { embed?: Embedder; chunkWords?: number; maxChunks?: number } = {}): Promise<number[][]> {
  const cache = new EmbeddingCache(cacheDir, CFG.embedModel); await cache.load();
  const embed = opts.embed ?? getTextEmbeddings;
  const chunkWords = opts.chunkWords ?? CFG.params.chunkWords, maxChunks = opts.maxChunks ?? CFG.params.maxChunks;
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
  const embs = await embed(items, { cache });
  await cache.save();
  const dim = embs[0]?.length ?? 384;
  return texts.map((_, di) => {
    const idx = spans[di], acc = new Array(dim).fill(0);
    for (const i of idx) for (let j = 0; j < dim; j++) acc[j] += embs[i][j];
    return acc.map((x) => x / (idx.length || 1));
  });
}

// The card as the map's coordinates: one chunk-pooled embedding of the whole card text (see cardText).
export async function embedCards(cards: Card[], axes: Axis[]): Promise<number[][]> {
  return poolEmbed(cards.map((c) => cardText(c, axes)), cachePath("cache-eidoscope-cards"));
}

// Full-text embedding for the generic path (when a loader has no precomputed embeddings).
export async function embedDocs(docs: Doc[]): Promise<number[][]> {
  return poolEmbed(docs.map((d) => (d.title ? d.title + ". " : "") + d.body), cachePath("cache-eidoscope-fulltext"));
}

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

// kNN on unit vectors (cosine = dot). Exact brute force for small n; approximate HNSW past HNSW_MIN,
// where O(n²) stops being affordable. Both are here as named functions so a test can assert the
// approximate index agrees with the exact answer on a synthetic set — the swap is a scale optimization,
// not a change in what a "neighbor" means.
export const HNSW_MIN = 3000;
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
export async function knnHNSW(X: number[][], K: number): Promise<number[][]> {
  const index = new HNSW(16, 200, X[0].length, "cosine");
  await index.buildIndex(X.map((v, i) => ({ id: i, vector: v })));
  const nbr: number[][] = [];
  for (let i = 0; i < X.length; i++) nbr.push((await index.searchKNN(X[i], K + 1)).map((r: any) => r.id as number).filter((j) => j !== i).slice(0, K));
  return nbr;
}

export function normPct(arr: number[][], dims: number): number[][] {
  const b = Array.from({ length: dims }, (_, j) => { const c = arr.map((r) => r[j]).sort((a, z) => a - z); const q = (p: number) => c[Math.floor(p * (c.length - 1))]; return [q(0.02), q(0.98)] as [number, number]; });
  return arr.map((r) => r.map((v, j) => +(((v - (b[j][0] + b[j][1]) / 2) / (((b[j][1] - b[j][0]) / 2) || 1))).toFixed(4)));
}

export async function projectAndCluster(embs: number[][]) {
  const X = embs.map(unit);
  const n = X.length;
  if (n < 5) { // too few points for UMAP/clustering — lay them on a ring so the tool still runs
    const xy = X.map((_, i) => [Math.cos((2 * Math.PI * i) / n) * 0.6, Math.sin((2 * Math.PI * i) / n) * 0.6] as number[]);
    const one = X.map(() => 0);
    return { xy, xyz: xy.map((p) => [p[0], p[1], 0]), cluster: one, k: 1, di: 0, levels: [one], counts: [1], hub: X.map(() => 0), nbr: X.map(() => [] as number[]) };
  }
  const nn = Math.max(2, Math.min(15, n - 1)); // small corpora have fewer points than neighbors
  // Seeded: umap-js takes a `random` fn. Unseeded it draws from Math.random for init + negative sampling,
  // so the same corpus laid out twice gave different coordinates. Each fit gets its OWN generator (from the
  // same seed) so the 2D layout is unaffected by whether the 3D one ran first.
  const xy = normPct(new UMAP({ nComponents: 2, nNeighbors: nn, minDist: 0.15, random: mulberry32(SEED) }).fit(X), 2);
  const xyz = normPct(new UMAP({ nComponents: 3, nNeighbors: nn, minDist: 0.15, random: mulberry32(SEED) }).fit(X), 3);
  // GRAIN LEVELS: a nested tree of clusterings, not one arbitrary k. The viewer slides between them.
  const { levels, counts } = n < 6 ? { levels: [X.map(() => 0)], counts: [1] } : divisiveLevels(X);
  // default view = the level nearest ~18 groups (human-scannable); the slider exposes the rest.
  let di = 0, best = Infinity; counts.forEach((c, i) => { const d = Math.abs(c - 18); if (d < best) { best = d; di = i; } });
  const cluster = levels[di] ?? X.map(() => 0), k = counts[di] ?? 1; // di = default level index; the slider exposes the rest
  // kNN + hubness (cosine on unit vectors = dot). hnsw at scale (O(n log n)); brute for small n.
  const K = 8, hub = new Array(n).fill(0);
  const nbr = n > HNSW_MIN ? await knnHNSW(X, K) : knnBrute(X, K);
  for (const top of nbr) for (const j of top) hub[j]++;
  return { xy, xyz, cluster, k, di, levels, counts, hub, nbr };
}

// verify: (1) MiniLM embeds card text, (2) umap-js + curare-cluster lay out real card embeddings
if (import.meta.main) {
  const { loadFixture, fixtureAxes } = await import("./corpus.ts");
  const { cardCorpus } = await import("./card.ts");
  const axes = fixtureAxes();
  const { docs } = loadFixture();
  const sample = docs.filter((d) => d.body.length > 2000).slice(0, 12);
  const deck = await cardCorpus(sample, axes, { concurrency: 8 });
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
