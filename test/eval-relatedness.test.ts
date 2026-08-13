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
