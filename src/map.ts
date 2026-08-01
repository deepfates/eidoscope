import { readFileSync } from "node:fs";
import { UMAP } from "umap-js";
import type { Card } from "./card.ts";
import type { Axis } from "./axes.ts";
import type { Doc } from "./corpus.ts";
import { CFG } from "./config.ts";
import { getTextEmbeddings, EmbeddingCache } from "./embed.ts";
import { findOptimalK, clusterEmbeddings } from "./cluster.ts";

// Embed the DECK (local MiniLM) and lay it out (umap-js) — the readers' coordinates.
// Embeds the cleaned, structured card text, not the raw document: that's what de-noises the map.

export const cardText = (c: Card, axes: Axis[]) => (c.core || "") + " " + axes.map((a) => c.axes[a.key]?.note || "").filter(Boolean).join(". ");

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

export async function embedCards(cards: Card[], axes: Axis[]): Promise<number[][]> {
  const cache = new EmbeddingCache("cache-eidoscope-cards", CFG.embedModel); await cache.load();
  const embs = await getTextEmbeddings(cards.map((c) => ({ id: c.id, text: cardText(c, axes).slice(0, 1200) })), { cache });
  await cache.save();
  return embs;
}

// Full-text embedding for the generic path: chunk each document body, embed, mean-pool.
// (When a loader already provides embeddings — e.g. the readwise fixture — skip this.)
export async function embedDocs(docs: Doc[]): Promise<number[][]> {
  const cache = new EmbeddingCache("cache-eidoscope-fulltext", CFG.embedModel); await cache.load();
  const { chunkWords, maxChunks } = CFG.params;
  // collect EVERY doc's chunks into one list and embed the whole corpus in a single batched pass —
  // identical vectors (each chunk is embedded independently) but far fewer calls at scale.
  const items: { id: string; text: string }[] = [];
  const spans: number[][] = docs.map(() => []);
  docs.forEach((d, di) => {
    const words = d.body.split(/\s+/).filter(Boolean);
    let chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkWords) chunks.push(words.slice(i, i + chunkWords).join(" "));
    if (chunks.length > maxChunks) { const step = chunks.length / maxChunks, s: string[] = []; for (let i = 0; i < maxChunks; i++) s.push(chunks[Math.floor(i * step)]); chunks = s; }
    if (!chunks.length) chunks = [d.title];
    chunks[0] = (d.title ? d.title + ". " : "") + chunks[0];
    chunks.forEach((text, ci) => { spans[di].push(items.length); items.push({ id: `${d.id}#${ci}`, text }); });
  });
  const embs = await getTextEmbeddings(items, { cache });
  await cache.save();
  const dim = embs[0]?.length ?? 384;
  return docs.map((_, di) => {
    const idx = spans[di], acc = new Array(dim).fill(0);
    for (const i of idx) for (let j = 0; j < dim; j++) acc[j] += embs[i][j];
    return acc.map((x) => x / (idx.length || 1));
  });
}

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
function normPct(arr: number[][], dims: number): number[][] {
  const b = Array.from({ length: dims }, (_, j) => { const c = arr.map((r) => r[j]).sort((a, z) => a - z); const q = (p: number) => c[Math.floor(p * (c.length - 1))]; return [q(0.02), q(0.98)] as [number, number]; });
  return arr.map((r) => r.map((v, j) => +(((v - (b[j][0] + b[j][1]) / 2) / (((b[j][1] - b[j][0]) / 2) || 1))).toFixed(4)));
}

export async function projectAndCluster(embs: number[][]) {
  const X = embs.map(unit);
  if (X.length < 5) { // too few points for UMAP/clustering — lay them on a ring so the tool still runs
    const xy = X.map((_, i) => [Math.cos((2 * Math.PI * i) / X.length) * 0.6, Math.sin((2 * Math.PI * i) / X.length) * 0.6] as number[]);
    return { xy, xyz: xy.map((p) => [p[0], p[1], 0]), cluster: X.map(() => 0), k: 1, hub: X.map(() => 0), nbr: X.map(() => [] as number[]) };
  }
  const nn = Math.max(2, Math.min(15, X.length - 1)); // small corpora have fewer points than neighbors
  const xy = normPct(new UMAP({ nComponents: 2, nNeighbors: nn, minDist: 0.15 }).fit(X), 2);
  const xyz = normPct(new UMAP({ nComponents: 3, nNeighbors: nn, minDist: 0.15 }).fit(X), 3);
  const kMax = Math.max(2, Math.min(60, Math.floor(X.length / 4)));  // k must stay < #points
  const k = X.length < 6 ? 1 : findOptimalK(X, kMax);
  const clusters = k <= 1 ? X.map(() => 0) : clusterEmbeddings(X, k).clusters;
  // kNN + hubness (cosine on unit vectors = dot)
  const K = 8, n = X.length, nbr: number[][] = [], hub = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let s = 0; const a = X[i], b = X[j]; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; sims.push([j, s]); }
    sims.sort((a, b) => b[1] - a[1]);
    const top = sims.slice(0, K).map(([j]) => j); nbr.push(top); for (const j of top) hub[j]++;
  }
  return { xy, xyz, cluster: clusters as number[], k, hub, nbr };
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
  const CE = JSON.parse(readFileSync("/Users/deepfates/Hacking/readwise/triangulation/runs/main/card-embs.json", "utf8"));
  console.error(`projecting ${CE.embs.length} fixture card embeddings...`);
  const { xy, xyz, cluster, k, hub } = await projectAndCluster(CE.embs);
  const xs = xy.map((p) => p[0]);
  console.log(`(2) umap 2D: ${xy.length} pts, x∈[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}], 3D dims=${xyz[0].length}`);
  console.log(`    clusters: k=${k}, sizes=[${Array.from({ length: k }, (_, c) => cluster.filter((x) => x === c).length).join(",")}]`);
  console.log(`    hubness range ${Math.min(...hub)}–${Math.max(...hub)}`);
  const ok = cardEmbs[0]?.length === 384 && xy.length === CE.embs.length && k >= 6;
  console.log(ok ? "\n✅ embed+project stage works — MiniLM embeds, umap-js lays out, kmeans clusters" : "\n⚠ inspect");
}
