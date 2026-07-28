import { readFileSync } from "node:fs";

// FAITHFULNESS: does the card (the interpretable re-description) preserve where the document
// actually sits? For each doc, compare its nearest neighbors in FULL-TEXT embedding space (the
// ground truth) to its neighbors in CARD embedding space. High overlap = the concept-bottleneck
// kept the doc's real neighborhood instead of distorting/collapsing it. This is the metric the
// optimizer will try to raise — and the baseline it must beat.

const dot = (a: number[], b: number[]) => { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; };
const unit = (v: number[]) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
function knnSets(X: number[][], k: number): Set<number>[] {
  const N = X.map(unit);
  return N.map((v, i) => { const s: [number, number][] = []; for (let j = 0; j < N.length; j++) if (j !== i) s.push([j, dot(v, N[j])]); s.sort((a, b) => b[1] - a[1]); return new Set(s.slice(0, k).map(([j]) => j)); });
}

// mean fraction of each doc's full-text kNN that also appear in its card-space kNN
export function neighborFaithfulness(textEmbs: number[][], cardEmbs: number[][], k = 10): number {
  const kt = knnSets(textEmbs, k), kc = knnSets(cardEmbs, k);
  let tot = 0; for (let i = 0; i < textEmbs.length; i++) { let o = 0; for (const j of kt[i]) if (kc[i].has(j)) o++; tot += o / k; }
  return tot / textEmbs.length;
}

// baseline on the fixture: current (un-optimized) cards vs full text
if (import.meta.main) {
  const FIX = "/Users/deepfates/Hacking/readwise/triangulation/runs/main";
  const CF = JSON.parse(readFileSync(`${FIX}/corpus-fulltext.json`, "utf8"));
  const CE = JSON.parse(readFileSync(`${FIX}/card-embs.json`, "utf8"));
  const textById = new Map<string, number[]>(CF.meta.map((m: any, i: number) => [m.id, CF.embs[i]]));
  const ids: string[] = CE.ids, cardEmbs: number[][] = [], textEmbs: number[][] = [];
  ids.forEach((id, i) => { const t = textById.get(id); if (t) { textEmbs.push(t); cardEmbs.push(CE.embs[i]); } });
  const k = 10;
  console.error(`${textEmbs.length} docs aligned (full-text + card embeddings)`);
  const score = neighborFaithfulness(textEmbs, cardEmbs, k);
  const randomFloor = k / textEmbs.length;
  console.log(`\nBASELINE neighbor-faithfulness (k=${k}): ${(score * 100).toFixed(1)}%`);
  console.log(`  random floor: ${(randomFloor * 100).toFixed(2)}%  ·  lift over random: ${(score / randomFloor).toFixed(0)}×`);
  console.log(`  → current cards preserve ${(score * 100).toFixed(0)}% of each doc's true full-text neighborhood.`);
  console.log(score > 0.15 ? "  the card layer is already fairly faithful; the swing is whether tuning can push it higher." : "  meaningful room to improve — good target for the optimizer.");
}
