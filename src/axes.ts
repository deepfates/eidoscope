import { readFileSync } from "node:fs";
import { Matrix, QR, SVD } from "ml-matrix";
import { labelAxes } from "./signatures.ts";
import { provider } from "./provider.ts";

// THE SOLID LAYER. Deterministic math discovers the axes; the model only labels them.
//  1. PCA on the (unit-normalized, centered) embeddings -> orthogonal axes of variation.
//  2. parallel analysis: shuffle each dimension to destroy structure, re-PCA, and keep only
//     axes whose variance beats the noise floor -> an HONEST real-dimension count.
//  3. labelAxis (Ax) names each top axis from the documents at its poles; keep the crisp ones.

export type Axis = { pc: number; var: number; coherence: number; key: string; name: string; pole_low: string; pole_high: string };

const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

// Seeded PRNG (mulberry32, no deps). The parallel-analysis shuffle used to draw from Math.random, so the
// noise floor — and therefore the honest dimension count — wobbled between identical runs. Same corpus +
// config must yield identical geometry, so the shuffle is seeded like every other stochastic step.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const SEED = 42;

// RANDOMIZED TRUNCATED PCA (Halko–Martinsson–Tropp range finder).
// We only ever look at the top ~60 components, but a full thin SVD of an n x 384 matrix computes all
// 384 of them — and discovery runs NINE of those (1 real + 8 parallel-analysis replicates). Instead:
// draw a Gaussian test matrix Ω (d x ℓ, ℓ = k + oversample), sketch Y = AΩ (n x ℓ), sharpen it with a
// couple of power iterations Y <- A(AᵀY) (re-orthonormalizing between so the small singular values
// don't drown in round-off), take Q = qr(Y).Q as an orthonormal basis for A's dominant range, then
// SVD the SMALL projected matrix B = QᵀA (ℓ x d) EXACTLY. A ≈ QB, so B's right singular vectors are
// A's top components and B's singular values are A's. Everything stochastic runs off the same seeded
// mulberry32 as the rest of the pipeline, so the geometry is still bit-identical run to run.
// Defaults chosen by MEASUREMENT on the real 1446 x 384 Readwise corpus, not by taste. Embedding
// spectra decay slowly, so the textbook (p=10, q=2) sketch is only accurate through ~PC17 there
// (|cos| vs full PCA drops to 0.9976 by PC18). (p=20, q=4) reproduces the full SVD to ~1e-6 relative
// variance and |cos| = 1.000000 through PC17, ~1e-3 through PC48 — and still runs the nine-PCA
// discovery step in 4.0s where nine full SVDs take 31s (~7.6x). The honest axes are the product's
// spine, so we buy the accuracy back; the speedup is what's left over.
const OVERSAMPLE = 20, POWER_ITERS = 4;

export type TruncPCA = { components: number[][]; explainedVariance: number[]; singularValues: number[]; mean: number[]; project: (X: number[][]) => number[][] };

export function truncatedPCA(X: number[][], k: number, opts: { seed?: number; oversample?: number; powerIters?: number } = {}): TruncPCA {
  const n = X.length, d = X[0].length;
  const rnd = mulberry32(opts.seed ?? SEED);
  // standard normal via Box–Muller off the seeded uniform stream
  const gauss = () => { const u = Math.max(rnd(), 1e-12), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const mean = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const A = new Matrix(n, d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) A.set(i, j, X[i][j] - mean[j]);
  // total variance = sum of the centered columns' variances (denominator for the explained fractions)
  let total = 0;
  for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < n; i++) { const x = A.get(i, j); s += x * x; } total += s / (n - 1 || 1); }

  const kk = Math.min(k, n, d);
  const ell = Math.min(kk + (opts.oversample ?? OVERSAMPLE), n, d);
  // AᵀM by hand: ml-matrix would need a materialized transpose (a second n x d matrix — 300MB at 100k
  // docs), and its lazy MatrixTransposeView measured ~4x slower through mmul. Same flops, no copy.
  const atMul = (M: Matrix) => { const c = M.columns, out = new Matrix(d, c); for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) { const a = A.get(i, j); if (!a) continue; for (let t = 0; t < c; t++) out.set(j, t, out.get(j, t) + a * M.get(i, t)); } return out; };
  let Y = A.mmul(Matrix.from1DArray(d, ell, Array.from({ length: d * ell }, gauss)));
  Y = new QR(Y).orthogonalMatrix;
  for (let it = 0; it < (opts.powerIters ?? POWER_ITERS); it++) {
    Y = new QR(A.mmul(atMul(Y))).orthogonalMatrix;
  }
  const B = atMul(Y).transpose();                                // ell x d, small
  const svd = new SVD(B, { autoTranspose: true });
  const V = svd.rightSingularVectors;                   // d x ell
  const sv = svd.diagonal.slice(0, kk);
  const components = Array.from({ length: kk }, (_, c) => Array.from({ length: d }, (_, j) => V.get(j, c)));
  const explainedVariance = sv.map((s) => (s * s) / (n - 1 || 1) / (total || 1));
  const project = (Z: number[][]) => Z.map((row) => components.map((c) => { let s = 0; for (let j = 0; j < d; j++) s += (row[j] - mean[j]) * c[j]; return s; }));
  return { components, explainedVariance, singularValues: sv, mean, project };
}

const evr = (X: number[][], nc: number, seed: number) => truncatedPCA(X, nc, { seed }).explainedVariance;

function shuffleColumns(X: number[][], rnd: () => number): number[][] {
  const n = X.length, d = X[0].length, out = X.map((r) => r.slice());
  for (let j = 0; j < d; j++) for (let i = n - 1; i > 0; i--) { const k = (rnd() * (i + 1)) | 0; const t = out[i][j]; out[i][j] = out[k][j]; out[k][j] = t; }
  return out;
}
const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export async function discoverAxes(embeddings: number[][], titles: string[], opts: { topN?: number; minCoherence?: number; llm?: any; seed?: number } = {}) {
  const NC = 60;
  const X = embeddings.map(unit);
  const seed = opts.seed ?? SEED;
  const pca = truncatedPCA(X, NC, { seed });
  const variance = pca.explainedVariance;
  const scores = pca.project(X); // n x kept components

  // parallel analysis -> honest #dims above the 95th-pct noise floor. The replicates only need the
  // top-NC variance spectrum of each shuffle, so the truncated SVD is exactly enough here too.
  const REP = 8, noise: number[][] = [];
  const rnd = mulberry32(seed);
  for (let r = 0; r < REP; r++) noise.push(evr(shuffleColumns(X, rnd), NC, seed));
  const n95 = (k: number) => { const c = noise.map((row) => row[k]).sort((a, b) => a - b); return c[Math.floor(0.95 * (REP - 1))]; };
  let realDims = 0; for (let k = 0; k < Math.min(NC, variance.length); k++) { if (variance[k] > n95(k)) realDims++; else break; }

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
