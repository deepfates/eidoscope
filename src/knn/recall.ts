// ONE strict recall implementation, shared by the unit tests (test/knn.test.ts) and the real-browser
// probe (e2e/knn.probe.ts) — parallel copies of this logic is how a forgiving denominator survived
// one adversarial review round (2026-08), so it lives in exactly one place.
//
// STRICT means: the denominator is n×K (a truncated row loses recall, never dodges it), and rows are
// separately checked for shape — every row exactly K+1 UNIQUE, in-range, self-inclusive entries. An
// implementation returning one good neighbor per row scores ~1/K, not 1.0.

// Count of malformed rows (wrong count, wrong length, missing self, duplicates, out-of-range).
export function rowDefects(rows: number[][], n: number, K: number): number {
  if (rows.length !== n) return n;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (row.length !== K + 1 || row[0] !== i || new Set(row).size !== K + 1 || row.some((j) => j < 0 || j >= n)) bad++;
  }
  return bad;
}

// hits / (n × K) over the self-exclusive tail of each row.
export function strictRecall(got: number[][], truth: number[][], K: number): number {
  let hit = 0;
  for (let i = 0; i < got.length; i++) { const t = new Set(truth[i].slice(1)); for (const j of got[i].slice(1)) if (t.has(j)) hit++; }
  return hit / (got.length * K);
}
