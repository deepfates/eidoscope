// DERIVE's math, pinned where the answer is known: two planted clusters in a space we control. The e2e
// drives the same function through the real app; this fixes the CONTRACT.
import { test, expect } from "bun:test";
import { deriveDirection } from "../viewer/src/derive.ts";
import { cosineAll } from "../viewer/src/semantic.ts";

// two planted clusters: A along +e0, B along +e1, each with deterministic jitter
const N = 40, DIM = 6;
const vectors = Array.from({ length: N }, (_, i) => {
  const a = i < N / 2;
  return Array.from({ length: DIM }, (_, j) => (j === (a ? 0 : 1) ? 1 : 0) + 0.1 * Math.sin(i * 1.3 + j));
});
const A = Array.from({ length: N / 2 }, (_, i) => i);
const B = Array.from({ length: N / 2 }, (_, i) => i + N / 2);

test("the derived direction separates the planted clusters — every selected card scores above every other", () => {
  const dir = deriveDirection(vectors, A)!;
  expect(dir).not.toBeNull();
  const s = cosineAll(dir, vectors);
  const lowestSelected = Math.min(...A.map((i) => s[i]));
  const highestRest = Math.max(...B.map((i) => s[i]));
  expect(lowestSelected).toBeGreaterThan(highestRest);
  // and it is a unit vector (the scores are honest cosines, comparable across derivations)
  expect(Math.hypot(...dir)).toBeCloseTo(1, 6);
});

test("selecting the OTHER cluster flips the direction", () => {
  const a = deriveDirection(vectors, A)!, b = deriveDirection(vectors, B)!;
  let dot = 0; for (let j = 0; j < DIM; j++) dot += a[j] * b[j];
  expect(dot).toBeLessThan(-0.9);
});

test("it is deterministic, and independent of the order the examples arrive in", () => {
  const a = deriveDirection(vectors, A)!;
  const b = deriveDirection(vectors, [...A].reverse())!;
  expect(Array.from(a)).toEqual(Array.from(b));
  expect(Array.from(deriveDirection(vectors, A)!)).toEqual(Array.from(a));
});

test("a card's own length can't buy it a direction — vectors are unit-normalized first", () => {
  const scaled = vectors.map((v, i) => (i < N / 2 ? v.map((x) => x * 7) : v));
  expect(Array.from(deriveDirection(scaled, A)!).map((x) => +x.toFixed(6)))
    .toEqual(Array.from(deriveDirection(vectors, A)!).map((x) => +x.toFixed(6)));
});

test("no honest direction → null (no vectors, empty set, the WHOLE corpus, or coincident centroids)", () => {
  expect(deriveDirection(undefined, A)).toBeNull();          // a lite emit carries no vectors
  expect(deriveDirection([], A)).toBeNull();
  expect(deriveDirection(vectors, [])).toBeNull();           // nothing held
  expect(deriveDirection(vectors, [...A, ...B])).toBeNull(); // no "rest" to contrast against
  expect(deriveDirection(vectors, [-1, 999])).toBeNull();    // ids that resolved to nothing
  const flat = Array.from({ length: 10 }, () => [1, 0, 0]);  // every card identical → no discriminant
  expect(deriveDirection(flat, [0, 1])).toBeNull();
});
