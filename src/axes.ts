import { readFileSync } from "node:fs";
import { PCA } from "ml-pca";
import { labelAxis } from "./signatures.ts";
import { provider } from "./provider.ts";

// THE SOLID LAYER. Deterministic math discovers the axes; the model only labels them.
//  1. PCA on the (unit-normalized, centered) embeddings -> orthogonal axes of variation.
//  2. parallel analysis: shuffle each dimension to destroy structure, re-PCA, and keep only
//     axes whose variance beats the noise floor -> an HONEST real-dimension count.
//  3. labelAxis (Ax) names each top axis from the documents at its poles; keep the crisp ones.

export type Axis = { pc: number; var: number; coherence: number; key: string; name: string; pole_low: string; pole_high: string };

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const evr = (X: number[][], nc: number) => new PCA(X, { center: true }).getExplainedVariance().slice(0, nc);

function shuffleColumns(X: number[][]): number[][] {
  const n = X.length, d = X[0].length, out = X.map((r) => r.slice());
  for (let j = 0; j < d; j++) for (let i = n - 1; i > 0; i--) { const k = (Math.random() * (i + 1)) | 0; const t = out[i][j]; out[i][j] = out[k][j]; out[k][j] = t; }
  return out;
}
const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export async function discoverAxes(embeddings: number[][], titles: string[], opts: { topN?: number; minCoherence?: number; llm?: any } = {}) {
  const topN = opts.topN ?? 16, minCoh = opts.minCoherence ?? 4, NC = 60;
  const X = embeddings.map(unit);
  const pca = new PCA(X, { center: true });
  const variance = pca.getExplainedVariance();
  const scores = pca.predict(X).to2DArray(); // n x components

  // parallel analysis -> honest #dims above the 95th-pct noise floor
  const REP = 8, noise: number[][] = [];
  for (let r = 0; r < REP; r++) noise.push(evr(shuffleColumns(X), NC));
  const n95 = (k: number) => { const c = noise.map((row) => row[k]).sort((a, b) => a - b); return c[Math.floor(0.95 * (REP - 1))]; };
  let realDims = 0; for (let k = 0; k < NC; k++) { if (variance[k] > n95(k)) realDims++; else break; }

  // label top-N axes from their pole documents (Ax), multi-vote coherence
  const llm = opts.llm ?? provider();
  const all: Axis[] = [];
  for (let k = 0; k < topN; k++) {
    const order = titles.map((_, i) => [scores[i][k], i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const low = order.slice(0, 14).map(([, i]) => titles[i]).join("\n");
    const high = order.slice(-14).map(([, i]) => titles[i]).join("\n");
    const votes = (await Promise.all([0, 1, 2].map(() =>
      labelAxis.forward(llm, { highPoleTitles: high, lowPoleTitles: low }).catch(() => null)))).filter(Boolean) as any[];
    const coh = votes.length ? votes.reduce((s, v) => s + (Number(v.coherenceScore) || 1), 0) / votes.length : 1;
    const best = votes.sort((a, b) => (Number(b.coherenceScore) || 1) - (Number(a.coherenceScore) || 1))[0] || { axisName: `PC${k + 1}`, lowPoleLabel: "", highPoleLabel: "" };
    all.push({ pc: k + 1, var: +variance[k].toFixed(4), coherence: +coh.toFixed(1), key: slug(best.axisName) || `pc${k + 1}`, name: best.axisName, pole_low: best.lowPoleLabel, pole_high: best.highPoleLabel });
    process.stderr.write(`  PC${k + 1} var${(variance[k] * 100).toFixed(1)}% coh${coh.toFixed(1)}  ${best.axisName}\n`);
  }
  return { axes: all.filter((a) => a.coherence >= minCoh), all, realDims };
}

// verify against the fixture
if (import.meta.main) {
  const FIX = "/Users/deepfates/Hacking/readwise/triangulation/runs/main";
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
