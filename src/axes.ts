import { readFileSync } from "node:fs";
import { PCA } from "ml-pca";
import { labelAxes } from "./signatures.ts";
import { provider } from "./provider.ts";

// THE SOLID LAYER. Deterministic math discovers the axes; the model only labels them.
//  1. PCA on the (unit-normalized, centered) embeddings -> orthogonal axes of variation.
//  2. parallel analysis: shuffle each dimension to destroy structure, re-PCA, and keep only
//     axes whose variance beats the noise floor -> an HONEST real-dimension count.
//  3. labelAxis (Ax) names each top axis from the documents at its poles; keep the crisp ones.

export type Axis = { pc: number; var: number; coherence: number; key: string; name: string; pole_low: string; pole_high: string };

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const evr = (X: number[][], nc: number) => new PCA(X, { center: true }).getExplainedVariance().slice(0, nc);

// Seeded PRNG (mulberry32, no deps). The parallel-analysis shuffle used to draw from Math.random, so the
// noise floor — and therefore the honest dimension count — wobbled between identical runs. Same corpus +
// config must yield identical geometry, so the shuffle is seeded like every other stochastic step.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const SEED = 42;

function shuffleColumns(X: number[][], rnd: () => number): number[][] {
  const n = X.length, d = X[0].length, out = X.map((r) => r.slice());
  for (let j = 0; j < d; j++) for (let i = n - 1; i > 0; i--) { const k = (rnd() * (i + 1)) | 0; const t = out[i][j]; out[i][j] = out[k][j]; out[k][j] = t; }
  return out;
}
const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export async function discoverAxes(embeddings: number[][], titles: string[], opts: { topN?: number; minCoherence?: number; llm?: any; seed?: number } = {}) {
  const NC = 60;
  const X = embeddings.map(unit);
  const pca = new PCA(X, { center: true });
  const variance = pca.getExplainedVariance();
  const scores = pca.predict(X).to2DArray(); // n x components

  // parallel analysis -> honest #dims above the 95th-pct noise floor
  const REP = 8, noise: number[][] = [];
  const rnd = mulberry32(opts.seed ?? SEED);
  for (let r = 0; r < REP; r++) noise.push(evr(shuffleColumns(X, rnd), NC));
  const n95 = (k: number) => { const c = noise.map((row) => row[k]).sort((a, b) => a - b); return c[Math.floor(0.95 * (REP - 1))]; };
  let realDims = 0; for (let k = 0; k < NC; k++) { if (variance[k] > n95(k)) realDims++; else break; }

  // Surface only as many axes as the DATA supports. realDims (the parallel-analysis count of PCs
  // that beat noise) is the honest ceiling — cap the fixed request by it so we never show more
  // interpretable axes than are actually real. (This is the fix for a 24-doc corpus with 8 real
  // dims still showing a hardcoded top-16: half the axes were noise by our own measurement.)
  const topN = Math.min(opts.topN ?? 16, Math.max(realDims, 2), variance.length);

  // Label ALL top-N axes in ONE call so the model sees the whole orthogonal set and names each a
  // DISTINCT contrast — instead of 16 isolated calls each rediscovering the dominant one. (Verified:
  // this cuts cross-axis score redundancy ~0.39->0.25 on the fixture; isolated labeling collapsed
  // ~9/16 axes onto "technical vs theoretical" even though the PCA directions are orthogonal.)
  const llm = opts.llm ?? provider();
  const poleBlock = Array.from({ length: topN }, (_, k) => {
    const order = titles.map((_, i) => [scores[i][k], i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const low = order.slice(0, 14).map(([, i]) => titles[i]).join("; ");
    const high = order.slice(-14).map(([, i]) => titles[i]).join("; ");
    return `AXIS ${k + 1}\n HIGH: ${high}\n LOW: ${low}`;
  }).join("\n\n");
  const r: any = await labelAxes.forward(llm, { axesPoles: poleBlock }).catch(() => ({}));
  const all: Axis[] = Array.from({ length: topN }, (_, k) => {
    const name = r.axisNames?.[k] || `PC${k + 1}`;
    const coh = Number(r.coherenceScores?.[k]) || 3;
    process.stderr.write(`  PC${k + 1} var${(variance[k] * 100).toFixed(1)}% coh${coh}  ${name}\n`);
    return { pc: k + 1, var: +variance[k].toFixed(4), coherence: +coh.toFixed(1), key: slug(name) || `pc${k + 1}`, name, pole_low: r.lowPoleLabels?.[k] || "", pole_high: r.highPoleLabels?.[k] || "" };
  });
  // The axis COUNT is grug's call, not gorm's: it's min(topN, realDims), fixed deterministically
  // above, so the same corpus yields the same axes every run. gorm only NAMES them; `coherence` is
  // kept as a per-axis signal, never a gate — a noisy LLM rating must not change how many axes exist.
  // (This is what made the count swing 16 -> 2 across identical runs before.)
  return { axes: all, all, realDims, projections: scores };
}

// verify against the fixture
if (import.meta.main) {
  const FIX = process.env.EIDOSCOPE_FIXTURE ?? "";
  const C = JSON.parse(readFileSync(`${FIX}/corpus-fulltext.json`, "utf8"));
  const keep = new Set(JSON.parse(readFileSync(`${FIX}/clean-ids.json`, "utf8")).keep);
  const rows = C.meta.map((m: any, i: number) => ({ m, i })).filter((r: any) => keep.has(r.m.id));
  const embeddings = rows.map((r: any) => C.embs[r.i]);
  const titles = rows.map((r: any) => (r.m.title || "").slice(0, 64));
  console.error(`fixture: ${embeddings.length} clean docs\n`);
  const { axes, all, realDims } = await discoverAxes(embeddings, titles);
  const fix = JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
  console.log(`\nreal dims above noise floor: ${realDims}   (fixture/python: ~41)`);
  console.log(`crisp axes: ${axes.length}/${all.length}   (fixture/python: ${fix.length})`);
  console.log(axes.length >= 12 && realDims >= 30 ? "\n✅ solid layer reproduces the fixture's shape" : "\n⚠ off from fixture — inspect");
}
