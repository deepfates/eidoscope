import { readFileSync } from "node:fs";

// THE STANDING GUARD the coherence filter never was: are the discovered axes actually DISTINCT
// lenses, or restatements of one contrast? Measures cross-axis redundancy = mean |correlation|
// among the per-document card SCORES (the features that drive the map). Low = genuinely different
// axes; high = the map claims more dimensions than it has. Cheap: needs only a run's scores.

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1e-9; };
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); return mean(a.map((_, i) => (a[i] - ma) * (b[i] - mb))) / (sd(a) * sd(b)); };

export type RedundancyReport = { meanAbsR: number; strong: number; pairs: { a: string; b: string; r: number }[]; pass: boolean };

// scores: axisKey -> per-doc score vector (exactly the shape of map-data.json `scores`).
export function scoreRedundancy(scores: Record<string, number[]>, threshold = 0.3): RedundancyReport {
  const keys = Object.keys(scores);
  const pairs: { a: string; b: string; r: number }[] = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.push({ a: keys[i], b: keys[j], r: corr(scores[keys[i]], scores[keys[j]]) });
  const abs = pairs.map((p) => Math.abs(p.r));
  const meanAbsR = mean(abs);
  return { meanAbsR, strong: abs.filter((r) => r >= 0.5).length, pairs: pairs.slice().sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 6), pass: meanAbsR < threshold };
}

// FIDELITY: does each axis's LLM card-score actually track its own PCA direction? The deep, fuzzy
// PCs are hard for the model to read, so their scores drift from the direction they're named for.
// Low fidelity = an axis the cards don't really measure — the complement of the redundancy check.
export function scoreFidelity(scores: Record<string, number[]>, projections: number[][], pcByKey: Record<string, number>): { meanAbs: number; perAxis: { key: string; r: number }[]; weak: number } {
  const perAxis = Object.keys(scores).map((key) => {
    const pc = pcByKey[key];
    const ok = pc >= 0 && projections.length && pc < projections[0].length;
    return { key, r: ok ? corr(scores[key], projections.map((row) => row[pc])) : 0 };
  });
  return { meanAbs: mean(perAxis.map((a) => Math.abs(a.r))), perAxis, weak: perAxis.filter((a) => Math.abs(a.r) < 0.2).length };
}

// CLI: check a run's map-data.json (or the fixture). Nonzero exit if it fails the guard.
if (import.meta.main) {
  const path = process.argv[2] || "map-data.json";
  const D = JSON.parse(readFileSync(path, "utf8"));
  const scores: Record<string, number[]> = D.scores ?? D; // map-data.json has {scores}, or pass a bare map
  const names: Record<string, string> = Object.fromEntries((D.axes ?? []).map((a: any) => [a.key, a.name]));
  const r = scoreRedundancy(scores);
  const n = Object.keys(scores).length;
  console.log(`\naxis redundancy — ${n} axes, ${path}`);
  console.log(`  mean |r| = ${r.meanAbsR.toFixed(3)}   ·   ${r.strong}/${(n * (n - 1)) / 2} pairs |r|>=0.5   ·   target < 0.3`);
  console.log(`  most redundant:`);
  for (const p of r.pairs) console.log(`    |r|=${Math.abs(p.r).toFixed(2)}  «${(names[p.a] || p.a).slice(0, 30)}» ~ «${(names[p.b] || p.b).slice(0, 30)}»`);
  console.log(r.pass ? `\n✅ PASS — axes are distinct lenses (mean |r| ${r.meanAbsR.toFixed(3)} < 0.3)` : `\n⚠ FAIL — axes too redundant (mean |r| ${r.meanAbsR.toFixed(3)} >= 0.3); the map claims more dimensions than it has`);
  process.exit(r.pass ? 0 : 1);
}
