import { kmeans } from "ml-kmeans";

// Deterministic clustering, replacing curare's clusterEmbeddings/findOptimalK with the same lib
// (ml-kmeans) used directly. Seeded kmeans++ so runs reproduce; elbow method picks k.

const SEED = 42;

export function clusterEmbeddings(X: number[][], k: number): { clusters: number[] } {
  return { clusters: kmeans(X, k, { seed: SEED, initialization: "kmeans++" }).clusters };
}

const sqdist = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; };
function inertia(X: number[][], k: number): number {
  const r = kmeans(X, k, { seed: SEED, initialization: "kmeans++" });
  let s = 0; for (let i = 0; i < X.length; i++) s += sqdist(X[i], r.centroids[r.clusters[i]]);
  return s;
}

// Best-first DIVISIVE clustering → nested grain levels (a tree you slide, not one magic k).
// The corpus's structure is clumps-all-the-way-down (measured: split any loose group and it resolves
// into real families, tightness rising), so there is no single right cluster count — there's a hierarchy.
// We repeatedly split the LEAST-coherent group in two, snapshotting the partition at a geometric ladder of
// counts. Each snapshot refines the previous (nested), so a slider can move from "continents" to "towns".
// Cheaper than the elbow too (many small 2-means beat 59 full k-means), and never picks an arbitrary k.
const meanIntra = (X: number[][], idx: number[]): number => {
  const m = Math.min(idx.length, 40), step = Math.max(1, Math.floor(idx.length / m)), s: number[] = [];
  for (let i = 0; i < idx.length && s.length < m; i += step) s.push(idx[i]);
  let tot = 0, n = 0;
  for (let a = 0; a < s.length; a++) for (let b = a + 1; b < s.length; b++) { let d = 0; const p = X[s[a]], q = X[s[b]]; for (let k = 0; k < p.length; k++) d += p[k] * q[k]; tot += d; n++; }
  return n ? tot / n : 1;
};
export function divisiveLevels(X: number[][], opts: { maxClusters?: number; minSize?: number; ladder?: number[] } = {}): { levels: number[][]; counts: number[] } {
  const maxClusters = opts.maxClusters ?? 192, minSize = opts.minSize ?? 25;
  const ladder = new Set(opts.ladder ?? [4, 6, 9, 14, 21, 32, 48, 72, 108, 162]);
  type C = { idx: number[]; t?: number };
  const active: C[] = [{ idx: X.map((_, i) => i) }];
  const levels: number[][] = [], counts: number[] = [];
  const snap = () => { const a = new Array<number>(X.length); active.forEach((c, ci) => c.idx.forEach((i) => (a[i] = ci))); levels.push(a); counts.push(active.length); };
  while (active.length < maxClusters) {
    let worst = -1, wt = Infinity;
    for (let i = 0; i < active.length; i++) {
      if (active[i].idx.length <= minSize) continue;
      if (active[i].t === undefined) active[i].t = meanIntra(X, active[i].idx);
      if ((active[i].t as number) < wt) { wt = active[i].t as number; worst = i; }
    }
    if (worst < 0) break;
    const idx = active[worst].idx;
    const r = kmeans(idx.map((i) => X[i]), 2, { seed: SEED, initialization: "kmeans++", maxIterations: 40 });
    const a: number[] = [], b: number[] = []; r.clusters.forEach((c, i) => (c ? b : a).push(idx[i]));
    if (!a.length || !b.length) { active[worst].t = 1; continue; } // degenerate split → mark done
    active.splice(worst, 1, { idx: a }, { idx: b });
    if (ladder.has(active.length)) snap();
  }
  if (!counts.length || counts[counts.length - 1] !== active.length) snap();
  return { levels, counts };
}

// Elbow — matched to curare's exact method (gold): sweep k in [2, kMax], WCSS per k, pick the k
// with max VERTICAL distance from the chord joining the curve's endpoints. Same seed → same k.
// (Retained for reference; the pipeline uses divisiveLevels — there is no single right k on real corpora.)
export function findOptimalK(X: number[][], kMax?: number): number {
  const n = X.length;
  if (n < 3) return Math.min(n, 2);
  const minK = 2, maxK = Math.min(kMax ?? Math.min(Math.max(3, Math.round(Math.cbrt(n))), 50), n - 1);
  if (maxK <= minK) return minK;
  const w: number[] = [];
  for (let k = minK; k <= maxK; k++) w.push(inertia(X, k));
  const num = w.length, first = w[0], last = w[num - 1];
  let bestK = minK, maxDist = 0;
  for (let i = 0; i < num; i++) {
    const lineY = first + (last - first) * (i / (num - 1));
    const d = Math.abs(w[i] - lineY);
    if (d > maxDist) { maxDist = d; bestK = minK + i; }
  }
  return bestK;
}
