// ef CALIBRATION for the hnsw regime, host-free — shared by hnswlib-node (src/map.ts) and the
// vendored wasm build (vendor/hnswlib-wasm/hnsw.ts).
//
// WHY: a fixed efSearch is a lie at scale. ef=64 measured recall 0.933 at n=30k, d=384, K=14 on
// clustered data (adversarial review, 2026-08) — more than half of all rows missing at least one
// true neighbor, silently, exactly on the no-GPU path where hnsw is the ground truth of the map.
// The ef needed for a recall level grows with corpus size and dimension, so it is MEASURED per
// index, never declared.
//
// HOW (each piece answers a review finding about statistical honesty, 2026-08):
//   sample    — a seeded-RNG shuffle (mulberry32; evenly-spaced sampling can alias corpus order)
//               orders the rows once. The first S rows TUNE ef; every certification draws a FRESH
//               disjoint chunk of S rows from the remaining shuffle — a holdout that fails becomes
//               selection data from then on and is never certified against again.
//   truth     — exact brute force (f64) for the sampled rows against the FULL set.
//   criterion — per-QUERY recalls, not per-slot: the K slots inside one query are correlated, so
//               the margin is mean ≥ claim + 3·SE with SE = sd(per-query recall)/√S — the MEASURED
//               standard error over S independent queries, no Bernoulli-independence assumption.
//   search    — `lo` is always an ef known INADEQUATE (tuning or a holdout failed there), `hi` a
//               tuning-passing ef: double hi until tuning passes, then binary-search (lo, hi] for
//               the smallest tuning-passing value (doubling alone overshoots up to 2×; the (lo, hi]
//               invariant holds across retries, where ef/2 may have previously passed tuning).
//   certify   — the chosen ef must pass on the fresh holdout; a failure marks it inadequate (lo=ef)
//               and tuning resumes higher, certified by the NEXT fresh chunk.
//   failure   — if ef reaches n without certifying, or the shuffle runs out of fresh holdout rows,
//               calibration returns ok:false and the CALLER FALLS BACK TO EXACT BRUTE FORCE — a
//               recall the index cannot demonstrably reach is never certified.
export const EF_RECALL_CLAIM = 0.99; // the product claim test/knn.test.ts gates at production scale
export const EF_SAMPLE = 200;        // queries per sample (tune and each holdout) — SE is measured, not assumed

const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export type EfCalibration = { ok: boolean; ef: number; holdoutRecall: number };

// TEST-ONLY escape hatch, module-private state — never a parameter on any production signature.
// Tests set an impossible claim to force the failure path through the REAL callers (exercising their
// exact-brute-force fallback), then MUST reset to null. Production code cannot reach this without
// importing a symbol whose name says exactly what it is.
let claimOverrideForTests: number | null = null;
export const __setClaimOverrideForTests = (c: number | null) => { claimOverrideForTests = c; };

export function calibrateEf(X: number[][], K: number, search: (i: number, k: number, ef: number) => number[], seed = 7): EfCalibration {
  const claim = claimOverrideForTests ?? EF_RECALL_CLAIM;
  const n = X.length, d = X[0].length;
  const S = Math.max(1, Math.min(EF_SAMPLE, Math.floor(n / 2)));
  const rnd = mulberry32(seed);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const exact = (i: number): Set<number> => {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let acc = 0; const a = X[i], b = X[j]; for (let t = 0; t < d; t++) acc += a[t] * b[t]; sims.push([j, acc]); }
    sims.sort((a, b) => b[1] - a[1]);
    return new Set(sims.slice(0, K).map(([j]) => j));
  };
  const tune = perm.slice(0, S), tuneTruth = tune.map(exact);
  let nextHoldout = S; // start of the next unused (fresh, disjoint) holdout chunk in the shuffle
  // per-query recalls → measured mean and standard error; pass = mean ≥ claim + 3·SE
  const measure = (rows: number[], truth: Set<number>[], ef: number) => {
    const rs = rows.map((i, s) => { let hit = 0; for (const j of search(i, K, ef)) if (truth[s].has(j)) hit++; return hit / K; });
    const mean = rs.reduce((a, r) => a + r, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rs.length - 1));
    return { mean, pass: mean >= claim + 3 * (sd / Math.sqrt(rs.length)) };
  };
  const floor = Math.max(32, K + 1); // hnswlib requires ef ≥ k; 32 is one doubling below the old fixed value
  let lo = floor - 1; // largest ef known INADEQUATE (tuning or a holdout failed there); floor-1 = none yet
  let hi = floor;     // candidate; made tuning-passing below before any certification
  for (;;) {
    while (!measure(tune, tuneTruth, hi).pass) {
      if (hi >= n) return { ok: false, ef: hi, holdoutRecall: measure(tune, tuneTruth, hi).mean };
      lo = hi;
      hi = Math.min(n, hi * 2);
    }
    // smallest tuning-passing ef in (lo, hi] — both bounds' statuses are known, including on retries
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (measure(tune, tuneTruth, mid).pass) hi = mid; else lo = mid;
    }
    // certify on a FRESH disjoint holdout chunk (never one that has influenced selection)
    if (nextHoldout + S > n) return { ok: false, ef: hi, holdoutRecall: measure(tune, tuneTruth, hi).mean };
    const hold = perm.slice(nextHoldout, nextHoldout + S); nextHoldout += S;
    const cert = measure(hold, hold.map(exact), hi);
    if (cert.pass) return { ok: true, ef: hi, holdoutRecall: cert.mean };
    if (hi >= n) return { ok: false, ef: hi, holdoutRecall: cert.mean };
    lo = hi; // the failed holdout marked this ef inadequate — it is selection data now, never reused
    hi = Math.min(n, hi * 2);
  }
}
