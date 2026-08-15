// The toolbar's priority collapse (eid-sh90 factoring; mechanism eid-ef7e / Hac-2hjp).
//
// This arithmetic has been wrong in production twice, and while it lived inside App.svelte it could not
// be tested without mounting the component — so it never was. The estimate is now a pure function and
// these are the cases that actually broke.
import { test, expect } from "bun:test";
import { foldEstimate, type FoldBox } from "../viewer/src/fold";

const boxes = (...tiers: number[]): FoldBox[] => tiers.map((tier) => ({ tier, width: 100 }));
const est = (avail: number, b: FoldBox[], o: Partial<Parameters<typeof foldEstimate>[0]> = {}) =>
  foldEstimate({ avail, fixed: 0, trigger: 40, boxes: b, max: 4, gap: 4, ...o });

test("a wide strip folds nothing", () => {
  expect(est(5000, boxes(0, 1, 2, 3))).toBe(0);
});

test("folding rises one tier at a time as the room runs out", () => {
  // 4 items × (100 + 4 gap) = 416 at fold 0. Each level drops one tier and adds the 40px trigger:
  //   fold 1 → 40 + 3×104 = 352   fold 2 → 40 + 2×104 = 248   fold 3 → 40 + 1×104 = 144
  // (`trigger` arrives with its own gap already folded in by measureFold, which is why it is not +4 here —
  //  I got that wrong writing this test, and the assertion caught me rather than the code.)
  const b = boxes(0, 1, 2, 3);
  expect(est(416, b)).toBe(0);
  expect(est(415, b)).toBe(1);
  expect(est(352, b)).toBe(1);
  expect(est(351, b)).toBe(2);
  expect(est(248, b)).toBe(2);
  expect(est(247, b)).toBe(3);
  expect(est(143, b)).toBe(4);              // nothing else can be folded; report the ceiling
});

// Tier 0 is the fold's whole promise: these controls are always reachable, so they are counted at every
// level and the estimate must never pretend they went away to make the row fit.
test("tier 0 is counted at every fold level, so a strip of only tier-0 controls saturates", () => {
  expect(est(10, boxes(0, 0, 0))).toBe(4);   // nothing can be folded away; report the ceiling, don't lie
  expect(est(10, boxes(0, 0, 0), { max: 2 })).toBe(2);
});

// The trigger is the "controls ▴" button, which only EXISTS once something has been folded. Counting it
// at fold 0 would make a strip that fits look like it doesn't.
test("the fold trigger costs nothing at level 0 and is paid for from level 1", () => {
  const b = boxes(0, 1);
  expect(est(208, b, { trigger: 1000 })).toBe(0);   // fits without folding → the huge trigger is irrelevant
  expect(est(207, b, { trigger: 1000 })).toBe(4);   // once folding starts the trigger must fit too
});

// `fixed` is the identity block and dividers — present at every level, like tier 0.
test("fixed chrome is charged at every level", () => {
  expect(est(300, boxes(0, 1), { fixed: 0 })).toBe(0);
  expect(est(300, boxes(0, 1), { fixed: 200 })).toBeGreaterThan(0);
});

// THE BUG THIS FUNCTION SHIPPED WITH, pinned as a property rather than a number: the estimate is a LOWER
// bound (it cannot see paddings, dividers or group gaps — measured under-counting by 53px at 1900 and
// 94px at 1280), and the watcher settles the rest by folding FURTHER against real overflow. So the
// estimate must never be too eager: at any width it must fold at most as much as at a narrower width.
test("the estimate is monotone in available width — it can only ever under-fold, never over-fold", () => {
  const b = boxes(0, 1, 1, 2, 3, 3);
  let prev = 4;
  for (let avail = 40; avail < 1200; avail += 7) {
    const f = est(avail, b);
    expect(f).toBeLessThanOrEqual(prev);   // wider is never more folded
    prev = f;
  }
  expect(prev).toBe(0);
});
