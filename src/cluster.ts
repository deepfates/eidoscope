import { kmeans } from "ml-kmeans";
import { GRAIN_MIN_REGION, GRAIN_RATIO } from "./schema.ts";

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
// We repeatedly split the LEAST-coherent group in two until every group reaches the GRAIN_MIN_REGION
// floor, then expose a geometric ladder of the recorded partitions. Each level refines the previous
// (nested), so a slider moves from "continents" to "towns".
//
// THE LADDER IS GENERATED, NOT HAND-TUNED (eid-iw04). We tried to derive it from the data with the
// standard criteria and the data declined to pick one: on the real corpora the gap statistic
// (Tibshirani, uniform-box reference) supports splits down to near-singletons, seed-perturbation
// stability (Jaccard ≥ 0.75, Hennig 2007) rejects the very first splits, and simplified silhouette is
// flat across every level — three standard instruments, three contradictory answers, which IS the
// answer: card-embedding space has real structure at every scale and no privileged one. So the ladder
// is an explicit UI pragmatic with exactly two constants (schema.ts): the GRAIN_MIN_REGION floor (a
// region's name should summarize a group, not a handful — it sets each corpus's emergent top kmax) and
// the GRAIN_RATIO notch step. No level list, no cluster cap: measured tops are 101 for n=1446 and 1045
// for n=13830 (the old 192 cap was hiding 5× of the finer grain).
const meanIntra = (X: number[][], idx: number[]): number => {
  const m = Math.min(idx.length, 40), step = Math.max(1, Math.floor(idx.length / m)), s: number[] = [];
  for (let i = 0; i < idx.length && s.length < m; i += step) s.push(idx[i]);
  let tot = 0, n = 0;
  for (let a = 0; a < s.length; a++) for (let b = a + 1; b < s.length; b++) { let d = 0; const p = X[s[a]], q = X[s[b]]; for (let k = 0; k < p.length; k++) d += p[k] * q[k]; tot += d; n++; }
  return n ? tot / n : 1;
};
// The slider's stops: k=2 (smallest nontrivial partition), then ×GRAIN_RATIO per notch, ending exactly
// at this corpus's emergent kmax. Pure and exported so the viewer/about pane can state it truthfully.
export function grainLadder(kmax: number): number[] {
  if (kmax < 2) return [Math.max(1, kmax)];
  const ks: number[] = [];
  for (let k = 2; k < kmax; k = Math.max(k + 1, Math.round(k * GRAIN_RATIO))) ks.push(k);
  ks.push(kmax);
  return ks;
}
export function divisiveLevels(X: number[][]): { levels: number[][]; counts: number[] } {
  type C = { idx: number[]; t?: number };
  const active: C[] = [{ idx: X.map((_, i) => i) }];
  // pass 1: split to exhaustion, recording each split so any intermediate partition can be replayed
  const events: { slot: number; a: number[]; b: number[] }[] = [];
  for (;;) {
    let worst = -1, wt = Infinity;
    for (let i = 0; i < active.length; i++) {
      if (active[i].idx.length <= GRAIN_MIN_REGION) continue;
      if (active[i].t === undefined) active[i].t = meanIntra(X, active[i].idx);
      if ((active[i].t as number) < wt) { wt = active[i].t as number; worst = i; }
    }
    if (worst < 0) break;
    const idx = active[worst].idx;
    const r = kmeans(idx.map((i) => X[i]), 2, { seed: SEED, initialization: "kmeans++", maxIterations: 40 });
    const a: number[] = [], b: number[] = []; r.clusters.forEach((c, i) => (c ? b : a).push(idx[i]));
    if (!a.length || !b.length) { active[worst].t = 1; continue; } // degenerate split → mark done
    events.push({ slot: worst, a, b });
    active.splice(worst, 1, { idx: a }, { idx: b });
  }
  // pass 2: replay the splits, snapshotting at the generated ladder's counts
  const ladder = new Set(grainLadder(active.length));
  const cur: number[][] = [X.map((_, i) => i)];
  const levels: number[][] = [], counts: number[] = [];
  const snap = () => { const a = new Array<number>(X.length); cur.forEach((idx, ci) => idx.forEach((i) => (a[i] = ci))); levels.push(a); counts.push(cur.length); };
  if (ladder.has(1)) snap();
  for (const e of events) { cur.splice(e.slot, 1, e.a, e.b); if (ladder.has(cur.length)) snap(); }
  if (!counts.length) snap();
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
