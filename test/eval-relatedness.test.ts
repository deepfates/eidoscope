// The relatedness eval's metric, pinned on synthetic data where the right answer is known by hand.
// (The verifiers themselves are external data; what a test can pin is that precision@k, the random-pair
// baseline and the lift mean what docs/EVAL.md says they mean.)
import { expect, test } from "bun:test";
import { scoreSpace, type LabelSet } from "../bin/eval-relatedness.ts";

// 40 documents, two labels alternating. Neighbour lists are built to be PERFECT (every neighbour shares
// the label), so precision@k must be exactly 1 and the baseline must be ~0.5 — the chance of two random
// documents landing in the same half.
const n = 40;
const alt: LabelSet = { kind: "cat", vals: Array.from({ length: n }, (_, i) => [i % 2 ? "b" : "a"]) };
const sameLabelNbr = Array.from({ length: n }, (_, i) => Array.from({ length: 4 }, (_, t) => (i + 2 * (t + 1)) % n));

test("precision@k is 1 for a perfect neighbourhood, and lift is 1/chance", () => {
  const c = scoreSpace("t", "s", sameLabelNbr, alt, 4, 20000)!;
  expect(c.metric).toBe("prec@k");
  expect(c.score).toBeCloseTo(1, 10);
  expect(c.base).toBeGreaterThan(0.45);
  expect(c.base).toBeLessThan(0.55);
  expect(c.lift).toBeGreaterThan(1.8);
  expect(c.coverage).toBe(1);
  expect(c.n).toBe(n);
});

test("a neighbourhood no better than chance scores lift ≈ 1", () => {
  // every document's neighbours are the next four indices — which alternate labels, i.e. exactly half
  const mixed = Array.from({ length: n }, (_, i) => [1, 2, 3, 4].map((d) => (i + d) % n));
  const c = scoreSpace("t", "s", mixed, alt, 4, 20000)!;
  expect(c.score).toBeCloseTo(0.5, 10);
  expect(c.lift).toBeGreaterThan(0.9);
  expect(c.lift).toBeLessThan(1.1);
});

test("unlabelled documents are excluded from the score and reported as coverage", () => {
  const half: LabelSet = { kind: "cat", vals: alt.vals.map((v, i) => (i < 20 ? (v as string[]) : undefined)) };
  const c = scoreSpace("t", "s", sameLabelNbr, half, 4, 20000)!;
  expect(c.coverage).toBeCloseTo(0.5, 10);
  expect(c.score).toBeCloseTo(1, 10);   // the unlabelled neighbours are dropped, not counted as misses
});

test("multi-valued labels count as shared when they overlap at all", () => {
  const multi: LabelSet = { kind: "cat", vals: Array.from({ length: n }, (_, i) => (i % 2 ? ["b", "x"] : ["a", "x"])) };
  const mixed = Array.from({ length: n }, (_, i) => [1, 2, 3, 4].map((d) => (i + d) % n));
  const c = scoreSpace("t", "s", mixed, multi, 4, 20000)!;
  expect(c.score).toBeCloseTo(1, 10);   // "x" is shared by everyone
});

test("scalar verifiers are scored as mean |Δ| with lift the other way up", () => {
  // value = index; neighbours are the two adjacent indices (|Δ| = 1.5 on average), random pairs are far
  const vals = Array.from({ length: n }, (_, i) => i);
  const L: LabelSet = { kind: "num", vals };
  const near = Array.from({ length: n }, (_, i) => [Math.max(0, i - 1), Math.min(n - 1, i + 1)]);
  const c = scoreSpace("t", "s", near, L, 2, 20000)!;
  expect(c.metric).toBe("mean|Δ|");
  expect(c.score).toBeLessThan(1.2);
  expect(c.base).toBeGreaterThan(10);   // mean |i-j| over uniform pairs ≈ n/3
  expect(c.lift).toBeGreaterThan(8);    // lift = baseline / observed, so closer neighbours score higher
});

test("a corpus with fewer than ten labelled documents is not scored at all", () => {
  const sparse: LabelSet = { kind: "cat", vals: alt.vals.map((v, i) => (i < 5 ? (v as string[]) : undefined)) };
  expect(scoreSpace("t", "s", sameLabelNbr, sparse, 4, 1000)).toBeNull();
});

// ── PAIRED BOOTSTRAP ─────────────────────────────────────────────────────────────────────────────────
// Added because the harness reported point estimates with no uncertainty and they were being compared to
// each other: "3.42x vs 3.32x, the cards win" on 274 documents was noise, and nothing in the tool said so.
import { bootstrapDiff, type Cell } from "../bin/eval-relatedness";

const cellOf = (per: (number | null)[], metric: Cell["metric"] = "prec@k"): Cell => ({
  corpus: "c", space: "s", verifier: "v", k: 10, n: per.length, coverage: 1, score: 0, base: 0, lift: 0, metric,
  perDoc: Float64Array.from(per.map((x) => (x === null ? NaN : x))),
});

test("a real difference excludes zero; an identical pair cannot", () => {
  const a = cellOf(Array.from({ length: 300 }, (_, i) => (i % 10) / 10));
  const better = cellOf(Array.from({ length: 300 }, (_, i) => (i % 10) / 10 + 0.2));
  const w = bootstrapDiff(better, a);
  expect(w.diff).toBeCloseTo(0.2, 6);
  expect(w.lo).toBeGreaterThan(0);            // a uniform +0.2 shift is not a coin flip
  const same = bootstrapDiff(a, cellOf(Array.from({ length: 300 }, (_, i) => (i % 10) / 10)));
  expect(same.diff).toBe(0);
  expect(same.lo).toBe(0); expect(same.hi).toBe(0);   // zero variance in the paired differences
});

// The failure this guards is the one that actually happened in the wild: a difference far smaller than
// the spread between documents, which looks decisive as two rounded point estimates and is not.
test("a difference smaller than the between-document spread is reported as straddling zero", () => {
  const rnd = (s: number) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const r = rnd(7);
  const base = Array.from({ length: 274 }, () => r());
  const a = cellOf(base);
  const b = cellOf(base.map((v) => Math.min(1, Math.max(0, v + (r() - 0.5) * 0.4))));   // noise, no true shift
  const w = bootstrapDiff(b, a);
  expect(w.lo).toBeLessThan(0); expect(w.hi).toBeGreaterThan(0);
  expect(w.n).toBe(274);
});

// Documents only one space could score must be dropped, not treated as zero — otherwise a space with
// thinner coverage is punished for the coverage rather than judged on the documents it shares.
test("only documents BOTH spaces scored are paired", () => {
  const a = cellOf([0.5, 0.5, null, 0.5]);
  const b = cellOf([0.5, null, 0.9, 0.5]);
  expect(bootstrapDiff(b, a).n).toBe(2);
});
