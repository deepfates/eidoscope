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
//   sample    — a seeded-RNG shuffle picks 2S distinct rows (mulberry32; evenly-spaced sampling can
//               alias corpus order). The first S rows TUNE ef; the other S are a HOLDOUT that
//               certifies it — the certifying sample never touched the selection, so the
//               certification is not circular.
//   truth     — exact brute force (f64) for the sampled rows against the FULL set.
//   criterion — per-QUERY recalls, not per-slot: the K slots inside one query are correlated, so
//               the margin is mean ≥ claim + 3·SE with SE = sd(per-query recall)/√S — the MEASURED
//               standard error over S independent queries, no Bernoulli-independence assumption.
//   search    — double ef from its floor until the tuning sample passes, then binary-search
//               (ef/2, ef] for the SMALLEST passing ef (doubling alone can overshoot the needed ef —
//               and every query's cost — by ~2×).
//   certify   — the holdout must pass at the chosen ef; a holdout failure resumes tuning higher.
//   failure   — if ef reaches n and either sample still fails, calibration returns ok:false and the
//               CALLER FALLS BACK TO EXACT BRUTE FORCE. ef=n means hnsw's candidate list is already
//               the whole graph, so n is small enough that exact is affordable — a recall the index
//               cannot reach is never certified, silently or otherwise.
export const EF_RECALL_CLAIM = 0.99; // the product claim test/knn.test.ts gates at production scale
export const EF_SAMPLE = 200;        // queries per sample (tune and holdout each) — SE is measured, not assumed

const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export type EfCalibration = { ok: boolean; ef: number; holdoutRecall: number };

export function calibrateEf(X: number[][], K: number, search: (i: number, k: number, ef: number) => number[], seed = 7): EfCalibration {
  const n = X.length, d = X[0].length;
  const S = Math.max(1, Math.min(EF_SAMPLE, Math.floor(n / 2)));
  // seeded shuffle → 2S distinct rows; first S tune, last S certify
  const rnd = mulberry32(seed);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const tune = perm.slice(0, S), holdout = perm.slice(S, 2 * S);
  const exact = (i: number): Set<number> => {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let acc = 0; const a = X[i], b = X[j]; for (let t = 0; t < d; t++) acc += a[t] * b[t]; sims.push([j, acc]); }
    sims.sort((a, b) => b[1] - a[1]);
    return new Set(sims.slice(0, K).map(([j]) => j));
  };
  const tuneTruth = tune.map(exact), holdTruth = holdout.map(exact);
  // per-query recalls → measured mean and standard error; pass = mean ≥ claim + 3·SE
  const measure = (rows: number[], truth: Set<number>[], ef: number) => {
    const rs = rows.map((i, s) => { let hit = 0; for (const j of search(i, K, ef)) if (truth[s].has(j)) hit++; return hit / K; });
    const mean = rs.reduce((a, r) => a + r, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rs.length - 1));
    return { mean, pass: mean >= EF_RECALL_CLAIM + 3 * (sd / Math.sqrt(rs.length)) };
  };
  const floor = Math.max(32, K + 1); // hnswlib requires ef ≥ k; 32 is one doubling below the old fixed value
  let ef = floor;
  for (;;) {
    // double until the tuning sample passes (or the candidate list is the whole graph)
    while (!measure(tune, tuneTruth, ef).pass) {
      if (ef >= n) return { ok: false, ef, holdoutRecall: measure(holdout, holdTruth, ef).mean };
      ef = Math.min(n, ef * 2);
    }
    // binary-search the smallest passing ef in (ef/2, ef] — doubling alone overshoots up to 2×
    let lo = Math.max(floor, Math.floor(ef / 2)), hi = ef;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (measure(tune, tuneTruth, mid).pass) hi = mid; else lo = mid;
    }
    ef = hi;
    // certify on the independent holdout; a failure resumes tuning from one doubling up
    const cert = measure(holdout, holdTruth, ef);
    if (cert.pass) return { ok: true, ef, holdoutRecall: cert.mean };
    if (ef >= n) return { ok: false, ef, holdoutRecall: cert.mean };
    ef = Math.min(n, ef * 2);
  }
}
