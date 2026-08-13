// The label chip's opacity (Hac-4adh) — derived from OCCLUSION, not contrast. The defect was a name
// over a dense bright cluster, where the field behind the glyphs is busy rather than merely low-contrast.
import { test, expect } from "bun:test";
import { chipAlpha, type RGB } from "../viewer/src/palette";

const DARK: RGB = [10, 12, 18], WHITE_INK: RGB = [255, 255, 255];
const LIGHT: RGB = [255, 255, 255], DARK_INK: RGB = [38, 38, 52];
const BRIGHT: RGB[] = [[255, 214, 10], [0, 255, 200], [255, 120, 200]];   // luminous dots, the worst case

test("a chip over bright dots is more opaque than the eyeballed value it replaces", () => {
  const a = chipAlpha(DARK, WHITE_INK, BRIGHT);
  expect(a).toBeGreaterThan(180 / 255);   // 0.706 — the value dark themes used to use, and the bug
  expect(a).toBeLessThanOrEqual(1);
});

// The property that actually defines the fix: whatever sits behind the chip must composite to within a
// just-noticeable difference, so the glyphs sit on something that reads as one flat surface.
test("at the derived alpha, the spread between backdrops collapses to near-nothing", () => {
  const a = chipAlpha(DARK, WHITE_INK, BRIGHT);
  const mix = (b: RGB): RGB => [0, 1, 2].map((i) => a * DARK[i] + (1 - a) * b[i]) as RGB;
  const composites = [...BRIGHT.map(mix), mix(DARK)];
  // crude sRGB distance is enough to assert they collapsed: every channel within a few levels
  for (const c of composites) for (const d of composites) {
    for (let i = 0; i < 3; i++) expect(Math.abs(c[i] - d[i])).toBeLessThan(25);
  }
});

test("a quiet backdrop needs less occlusion than a vivid one", () => {
  const dim: RGB[] = [[26, 30, 40], [30, 32, 42]];
  expect(chipAlpha(DARK, WHITE_INK, dim)).toBeLessThan(chipAlpha(DARK, WHITE_INK, BRIGHT));
});

test("a light theme derives its own alpha rather than inheriting the dark one", () => {
  expect(chipAlpha(LIGHT, DARK_INK, BRIGHT)).toBeGreaterThan(0.6);
});

test("no backdrops at all means nothing to hide behind — a solid chip", () => {
  expect(chipAlpha(DARK, WHITE_INK, [])).toBe(1);
});
