// ef CALIBRATION for the hnsw regime, host-free — shared by hnswlib-node (src/map.ts) and the
// vendored wasm build (vendor/hnswlib-wasm/hnsw.ts).
//
// WHY: a fixed efSearch is a lie at scale. ef=64 measured recall 0.933 at n=30k, d=384, K=14 on
// clustered data (adversarial review, 2026-08) — i.e. more than half of all rows missing at least one
// true neighbor, silently, exactly on the no-GPU path where hnsw is the ground truth of the map. The
// hnswlib literature says the same thing: the ef needed for a recall level grows with corpus size and
// dimension, so it must be MEASURED per index, not declared.
//
// HOW: after the index is built, take a deterministic sample of rows, compute their EXACT neighbors by
// brute force against the full set (f64, the same ground truth the tests use), then double ef from its
// floor until the sampled recall clears the target — the calibration is the recall receipt, run at
// build time on the real data. Search passes are cheap next to the build (the sample re-queries are a
// few percent of one full query pass), so the loop costs little and the final full pass runs at the
// calibrated ef.
//
// THE TARGET is derived, not picked: the product claim is ≥ 0.99 recall (test/knn.test.ts gates it at
// production scale). The sample estimates true recall with standard error sqrt(p(1-p)/m) over
// m = EF_SAMPLE·K ≈ 2800 neighbor slots → σ ≈ 0.0019 at p = 0.99, so the calibration aims 3σ above
// the claim (≈ 0.996) — a sample that passes here makes the full-set claim hold with ~99.9% confidence.
export const EF_RECALL_CLAIM = 0.99;              // the product claim the tests gate
export const EF_SAMPLE = 200;                     // sampled rows; m = 200·K slots → σ ≈ 0.2% at p≈0.99
export const efRecallTarget = (K: number) => {
  const m = EF_SAMPLE * K, p = EF_RECALL_CLAIM;
  return Math.min(1, p + 3 * Math.sqrt((p * (1 - p)) / m)); // claim + 3σ sampling margin
};

// Calibrate ef for a built index. `search(i, k, ef)` = the index's own answer for row i (self
// excluded, k labels). Returns the ef whose sampled recall clears the target (ef caps at n — at that
// point hnsw's candidate list is the whole graph and it can do no better).
export function calibrateEf(X: number[][], K: number, search: (i: number, k: number, ef: number) => number[]): { ef: number; sampledRecall: number } {
  const n = X.length, d = X[0].length;
  const S = Math.min(EF_SAMPLE, n);
  const step = n / S;
  const sample = Array.from({ length: S }, (_, s) => Math.floor(s * step)); // deterministic, evenly spread
  // exact truth for the sample rows, against the FULL set
  const truth: Set<number>[] = sample.map((i) => {
    const sims: [number, number][] = [];
    for (let j = 0; j < n; j++) { if (j === i) continue; let acc = 0; const a = X[i], b = X[j]; for (let t = 0; t < d; t++) acc += a[t] * b[t]; sims.push([j, acc]); }
    sims.sort((a, b) => b[1] - a[1]);
    return new Set(sims.slice(0, K).map(([j]) => j));
  });
  const target = efRecallTarget(K);
  let ef = Math.max(32, K + 1); // floor: hnswlib requires ef ≥ k; 32 is one doubling below the old fixed value
  for (;;) {
    let hit = 0;
    sample.forEach((i, s) => { for (const j of search(i, K, ef)) if (truth[s].has(j)) hit++; });
    const recall = hit / (S * K);
    if (recall >= target || ef >= n) return { ef, sampledRecall: recall };
    ef = Math.min(n, ef * 2);
  }
}
