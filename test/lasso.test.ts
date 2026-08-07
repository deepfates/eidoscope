// The lasso core, tested where it can be pinned exactly: a hand-made projector, so the behind-camera
// guard is exercised as arithmetic rather than inferred from a camera. The e2e drives the same code
// through a real deck viewport; this fixes the CONTRACT.
import { test, expect } from "bun:test";
import { pointInPolygon, selectInPolygon } from "../viewer/src/lasso.ts";

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];

test("pointInPolygon: inside, outside, and a concave notch", () => {
  expect(pointInPolygon(50, 50, square)).toBe(true);
  expect(pointInPolygon(150, 50, square)).toBe(false);
  expect(pointInPolygon(-1, 50, square)).toBe(false);
  // a C shape: the mouth is OUTSIDE even though it's inside the bounding box
  const c = [[0, 0], [100, 0], [100, 30], [40, 30], [40, 70], [100, 70], [100, 100], [0, 100]];
  expect(pointInPolygon(20, 50, c)).toBe(true);
  expect(pointInPolygon(80, 50, c)).toBe(false);
});

test("a path with fewer than 3 points selects nothing", () => {
  const r = selectInPolygon({ count: 3, positionOf: (i) => [i, i], project: (w) => [w[0], w[1], 0], path: [[0, 0], [10, 10]] });
  expect(r).toEqual([]);
});

test("the filter mask is respected — a hidden card is not selectable", () => {
  const opts = { count: 4, positionOf: (i: number) => [10 + i, 50], project: (w: number[]) => [w[0], w[1], 0], path: square };
  expect(selectInPolygon(opts)).toEqual([0, 1, 2, 3]);
  expect(selectInPolygon({ ...opts, mask: [1, 0, 1, 0] })).toEqual([0, 2]);
});

test("THE 3D GUARD: a behind-camera point that mirrors into the loop is rejected", () => {
  // Card 0 is genuinely in front (ndc z = 0). Card 1 is BEHIND the eye: perspective divide by a negative w
  // mirrors it through the origin, so its screen position lands squarely inside the loop — and deck reports
  // the giveaway as an out-of-range ndc z. Card 2 is in front but outside the loop.
  const project = (w: number[]) => (w[0] === 0 ? [50, 50, 0] : w[0] === 1 ? [50, 50, -4.3] : [500, 500, 0]);
  const base = { count: 3, positionOf: (i: number) => [i, 0, 0], project, path: square };
  // 2D (orthographic): there is no behind-camera case, so no clipping — both centre points count
  expect(selectInPolygon({ ...base, clipZ: false })).toEqual([0, 1]);
  // 3D (perspective): the mirrored card is dropped, and ONLY it
  expect(selectInPolygon({ ...base, clipZ: true })).toEqual([0]);
});

test("the guard keeps points at the near/far planes (|ndc z| == 1 is still visible)", () => {
  const project = (w: number[]) => [50, 50, w[0]];   // ndc z = the card's index-derived value
  const r = selectInPolygon({ count: 3, positionOf: (i) => [[-1, 1, 1.0001][i], 0, 0], project, path: square, clipZ: true });
  expect(r).toEqual([0, 1]);
});
