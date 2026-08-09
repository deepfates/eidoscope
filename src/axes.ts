import { EVD, Matrix, QR, SVD } from "ml-matrix";
import { labelAxes } from "./signatures.ts";

// HOST-FREE (eid-bacg): no node imports — this module runs identically in Bun and in the browser page.
// The LLM is always injected by the caller (the CLI passes provider(); the page passes its own ax
// client built from the user-held key); absent, axes fall back to PC names — same as a failed call.

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

// TRUNCATED PCA — the top k components only, never the full 384-way decomposition. Axis discovery
// runs NINE of these per corpus (1 real + 8 parallel-analysis replicates) and reads only the top 60,
// so a full thin SVD (ml-pca) was doing ~6x more work than anyone looked at. Two routes:
//
// 1. GRAM (default whenever d <= 2048 — i.e. every embedding model we ship, d = 384). Accumulate the
//    d x d covariance C = AᵀA/(n-1) in ONE cache-friendly pass over the rows, centering on the fly
//    (no n x d copy ever exists), then eigendecompose a 384 x 384 symmetric matrix. Eigenvectors ARE
//    the components, eigenvalues ARE the variances, trace is the total: EXACT, not an approximation.
//    Measured against nine full ml-pca SVDs on the real Readwise corpora: 1446 docs 31.3s -> 1.2s
//    (26x, peak RSS 184MB -> 47MB); 69586 docs 549s -> 27s (20x, 6.5GB -> 1.5GB). Agreement with the
//    full SVD is machine precision (relative variance error ~1e-14, |cos| = 1.000000 on all 49 kept
//    components) and the parallel-analysis dimension count is identical.
//
// 2. RANDOMIZED range finder (Halko–Martinsson–Tropp), for the wide case where a d x d Gram matrix
//    and its O(d³) eigendecomposition stop being cheap. Draw a seeded Gaussian Ω (d x ℓ, ℓ = k + p),
//    sketch Y = AΩ, sharpen with q power iterations Y <- A(AᵀY) (re-orthonormalizing between, or the
//    small singular values drown in round-off), take Q = qr(Y).Q as a basis for A's dominant range,
//    and SVD the SMALL B = QᵀA (ℓ x d) exactly; A ≈ QB, so B's right singular vectors are A's top
//    components. This is an APPROXIMATION: on the 1446-doc corpus the textbook (p=10, q=2) matches
//    the exact answer only through ~PC17 (|cos| 0.9976 by PC18), which is why the defaults are the
//    measured (p=20, q=4) — exact to ~1e-6 relative variance through PC17 and ~1e-3 through PC48.
//    Its flop count (~10·n·d·ℓ) EXCEEDS a thin SVD's (~n·d²) at ℓ=80, d=384, so it is NOT the fast
//    path for tall-thin embedding data — measured 41s vs 31s for one PCA at n=69586. Force it with
//    method:"randomized"; the seeded sketch keeps it bit-identical run to run either way.
const OVERSAMPLE = 20, POWER_ITERS = 4, GRAM_MAX_D = 2048;

// coordinates of any rows on the discovered components (centered with the SAME mean)
const projector = (components: number[][], mean: number[], d: number) => (Z: number[][]) =>
  Z.map((row) => components.map((c) => { let s = 0; for (let j = 0; j < d; j++) s += (row[j] - mean[j]) * c[j]; return s; }));

export type TruncPCA = { components: number[][]; explainedVariance: number[]; singularValues: number[]; mean: number[]; project: (X: number[][]) => number[][] };

export function truncatedPCA(X: number[][], k: number, opts: { seed?: number; oversample?: number; powerIters?: number; method?: "auto" | "gram" | "randomized" } = {}): TruncPCA {
  const n = X.length, d = X[0].length;
  const rnd = mulberry32(opts.seed ?? SEED);
  // standard normal via Box–Muller off the seeded uniform stream
  const gauss = () => { const u = Math.max(rnd(), 1e-12), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  const mean = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const kk = Math.min(k, n, d);

  // FAST EXACT PATH for tall-and-thin data — which is every embedding corpus we ship (d = 384, n in
  // the thousands to hundreds of thousands). Form the d x d covariance C = AᵀA/(n-1) in ONE cache-
  // friendly pass (exploiting symmetry, so half the work), then eigendecompose a 384 x 384 matrix.
  // The eigenvectors ARE the principal components and the eigenvalues ARE the variances — no
  // approximation, no random sketch, nothing to gate. Measured: 148ms at n=1446 and 2.3s at n=69586,
  // against 3.4s / 31s for one ml-pca full SVD and 0.45s / 41s for the randomized sketch below. The
  // sketch's flop count (~10·n·d·ℓ) actually EXCEEDS a thin SVD's (~n·d²) at ℓ=80, d=384; it only won
  // at small n because ml-pca's constant is large. Once n dominates, the Gram route wins outright.
  const method = opts.method ?? "auto";
  if (method === "gram" || (method === "auto" && d <= GRAM_MAX_D)) {
    // read the ORIGINAL rows and center on the fly: no n x d copy exists on this path at all
    const cov = new Float64Array(d * d), row = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      const src = X[i];
      for (let j = 0; j < d; j++) row[j] = src[j] - mean[j];
      for (let a = 0; a < d; a++) { const va = row[a]; if (!va) continue; const off = a * d; for (let b = a; b < d; b++) cov[off + b] += va * row[b]; }
    }
    const C = new Matrix(d, d);
    for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { const v = cov[a * d + b] / (n - 1 || 1); C.set(a, b, v); C.set(b, a, v); }
    let total = 0; for (let a = 0; a < d; a++) total += C.get(a, a);   // trace = total variance
    const e = new EVD(C, { assumeSymmetric: true });
    const order = e.realEigenvalues.map((v, i) => [v, i] as [number, number]).sort((x, y) => y[0] - x[0]).slice(0, kk);
    const EV = e.eigenvectorMatrix;
    const components = order.map(([, i]) => Array.from({ length: d }, (_, j) => EV.get(j, i)));
    const explainedVariance = order.map(([v]) => Math.max(v, 0) / (total || 1));
    const singularValues = order.map(([v]) => Math.sqrt(Math.max(v, 0) * (n - 1 || 1)));
    return { components, explainedVariance, singularValues, mean, project: projector(components, mean, d) };
  }

  const A = new Matrix(n, d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) A.set(i, j, X[i][j] - mean[j]);
  let total = 0;                       // total variance = sum of the centered columns' variances
  for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < n; i++) { const x = A.get(i, j); s += x * x; } total += s / (n - 1 || 1); }
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
  return { components, explainedVariance, singularValues: sv, mean, project: projector(components, mean, d) };
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
  const llm = opts.llm;
  const poleBlock = Array.from({ length: topN }, (_, k) => {
    const order = titles.map((_, i) => [scores[i][k], i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const low = order.slice(0, 14).map(([, i]) => titles[i]).join("; ");
    const high = order.slice(-14).map(([, i]) => titles[i]).join("; ");
    return `AXIS ${k + 1}\n HIGH: ${high}\n LOW: ${low}`;
  }).join("\n\n");
  const r: any = llm ? await Promise.resolve().then(() => labelAxes.forward(llm, { axesPoles: poleBlock })).catch(() => ({})) : {};
  const all: Axis[] = Array.from({ length: topN }, (_, k) => {
    const name = r.axisNames?.[k] || `PC${k + 1}`;
    const coh = Number(r.coherenceScores?.[k]) || 3;
    (globalThis as any).process?.stderr?.write?.(`  PC${k + 1} var${(variance[k] * 100).toFixed(1)}% coh${coh}  ${name}\n`);
    return { pc: k + 1, var: +variance[k].toFixed(4), coherence: +coh.toFixed(1), key: slug(name) || `pc${k + 1}`, name, pole_low: r.lowPoleLabels?.[k] || "", pole_high: r.highPoleLabels?.[k] || "" };
  });
  // The axis COUNT is grug's call, not gorm's: it's min(topN, realDims), fixed deterministically
  // above, so the same corpus yields the same axes every run. gorm only NAMES them; `coherence` is
  // kept as a per-axis signal, never a gate — a noisy LLM rating must not change how many axes exist.
  // (This is what made the count swing 16 -> 2 across identical runs before.)
  return { axes: all, all, realDims, projections: scores };
}

// verify against the fixture
if ((import.meta as any).main) {
  const dyn = (m: string) => import(/* @vite-ignore */ m);   // node-only path, invisible to the browser bundler
  const { readFileSync } = await dyn("node:fs");
  const { provider } = await dyn("./provider.ts");
  const FIX = process.env.EIDOSCOPE_FIXTURE ?? "";
  const C = JSON.parse(readFileSync(`${FIX}/corpus-fulltext.json`, "utf8"));
  const keep = new Set(JSON.parse(readFileSync(`${FIX}/clean-ids.json`, "utf8")).keep);
  const rows = C.meta.map((m: any, i: number) => ({ m, i })).filter((r: any) => keep.has(r.m.id));
  const embeddings = rows.map((r: any) => C.embs[r.i]);
  const titles = rows.map((r: any) => (r.m.title || "").slice(0, 64));
  console.error(`fixture: ${embeddings.length} clean docs\n`);
  const { axes, all, realDims } = await discoverAxes(embeddings, titles, { llm: provider() });
  const fix = JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
  console.log(`\nreal dims above noise floor: ${realDims}   (fixture/python: ~41)`);
  console.log(`crisp axes: ${axes.length}/${all.length}   (fixture/python: ${fix.length})`);
  console.log(axes.length >= 12 && realDims >= 30 ? "\n✅ solid layer reproduces the fixture's shape" : "\n⚠ off from fixture — inspect");
}
