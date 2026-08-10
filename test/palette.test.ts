import { expect, test, describe } from "bun:test";
import { derivePalette, buildRegionTree, treeHues, anchorHueOf, treeThemePalette, type ThemeTokens } from "../viewer/src/palette";
import { converter } from "culori";

// Fixtures are the token sets verbatim from daisyui/theme/*.css — the same values the browser hands
// readThemeTokens() at runtime, so what we assert here is what the map actually paints.
const THEMES: Record<string, ThemeTokens> = {
  // "black" is the hard case: every brand token is achromatic (oklch 35% 0 0), so the hue ring has to be
  // rebuilt from the semantic tokens alone, against a pure-black canvas.
  black: {
    "base-100": "oklch(0% 0 0)", "base-content": "oklch(87.609% 0 0)",
    primary: "oklch(35% 0 0)", secondary: "oklch(35% 0 0)", accent: "oklch(35% 0 0)", neutral: "oklch(35% 0 0)",
    info: "oklch(45.201% 0.313 264.052)", success: "oklch(51.975% 0.176 142.495)",
    warning: "oklch(96.798% 0.211 109.769)", error: "oklch(62.795% 0.257 29.233)",
  },
  light: {
    "base-100": "oklch(100% 0 0)", "base-content": "oklch(21% 0.006 285.885)",
    primary: "oklch(45% 0.24 277.023)", secondary: "oklch(65% 0.241 354.308)", accent: "oklch(77% 0.152 181.912)",
    neutral: "oklch(14% 0.005 285.823)", info: "oklch(74% 0.16 232.661)", success: "oklch(76% 0.177 163.223)",
    warning: "oklch(82% 0.189 84.429)", error: "oklch(71% 0.194 13.428)",
  },
  synthwave: {
    "base-100": "oklch(15% 0.09 281.288)", "base-content": "oklch(78% 0.115 274.713)",
    primary: "oklch(71% 0.202 349.761)", secondary: "oklch(82% 0.111 230.318)", accent: "oklch(75% 0.183 55.934)",
    neutral: "oklch(45% 0.24 277.023)", info: "oklch(74% 0.16 232.661)", success: "oklch(77% 0.152 181.912)",
    warning: "oklch(90% 0.182 98.111)", error: "oklch(73.7% 0.121 32.639)",
  },
};

// Canary thresholds. These are FLOORS, well under the measured values (recorded per theme below) — they
// exist to catch a regression that quietly collapses the palette, not to pin exact colours.
const FLOOR = { dE: 0.045, deuter: 0.02, contrast: 2.9 };
// measured at time of writing (bun test prints them):
//   black      minΔEOK 0.0892 · deuter 0.0490 · contrast 3.97
//   light      minΔEOK 0.0697 · deuter 0.0292 · contrast 3.03
//   synthwave  minΔEOK 0.0941 · deuter 0.0462 · contrast 3.79

describe("theme-derived palette", () => {
  for (const [name, tokens] of Object.entries(THEMES)) {
    test(`${name}: 24 distinguishable colours above the canary floors`, () => {
      const d = derivePalette(tokens);
      expect(d).not.toBeNull();
      const { colors, metrics } = d!;
      expect(colors.length).toBe(24);
      for (const c of colors) { expect(c.length).toBe(3); for (const v of c) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(255); }
      console.log(`  ${name}: minΔEOK ${metrics.minDEok.toFixed(4)} · deuter ${metrics.minDEokDeuter.toFixed(4)} · contrast ${metrics.worstContrast.toFixed(2)}`);
      expect(metrics.minDEok).toBeGreaterThanOrEqual(FLOOR.dE);
      expect(metrics.minDEokDeuter).toBeGreaterThanOrEqual(FLOOR.deuter);
      expect(metrics.worstContrast).toBeGreaterThanOrEqual(FLOOR.contrast);
    });
  }

  test("ground detection follows base-100's lightness, not a hardcoded list", () => {
    expect(derivePalette(THEMES.black)!.dark).toBe(true);
    expect(derivePalette(THEMES.synthwave)!.dark).toBe(true);   // a dark VIOLET ground, not a grey one
    expect(derivePalette(THEMES.light)!.dark).toBe(false);
  });

  test("deterministic: same tokens in, identical colours out", () => {
    for (const tokens of Object.values(THEMES)) {
      expect(derivePalette(tokens)!.colors).toEqual(derivePalette(tokens)!.colors);
    }
  });

  test("distinct themes give distinct palettes", () => {
    const b = derivePalette(THEMES.black)!.colors, s = derivePalette(THEMES.synthwave)!.colors;
    expect(b).not.toEqual(s);
  });

  test("pathological tokens are rejected so the caller can fall back", () => {
    expect(derivePalette({})).toBeNull();                                   // no tokens at all
    expect(derivePalette({ "base-100": "not-a-color", primary: "🙃" })).toBeNull();  // unparseable
    // a mid-grey canvas: no lightness band can clear even the degenerate 2.0:1 floor
    expect(derivePalette({ "base-100": "oklch(55% 0 0)", "base-content": "oklch(50% 0 0)" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TREE HUES (eid-yhj7): region colours follow the grain tree — hue = ancestry.
describe("grain-tree hues", () => {
  // a nested 3-level ladder over 12 nodes: 2 → 3 → 5 regions (region 1 never splits)
  const levels = [
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2],
    [0, 0, 3, 3, 1, 1, 4, 2, 2, 2, 2, 2],
  ];
  const tree = buildRegionTree(levels)!;
  const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

  test("tree derives parents/sizes from the levels arrays; real nesting has zero violations", () => {
    expect(tree.counts).toEqual([2, 3, 5]);
    expect(tree.parents[1]).toEqual([0, 0, 1]);
    expect(tree.parents[2]).toEqual([0, 1, 2, 0, 1]);
    expect(tree.sizes[0]).toEqual([7, 5]);
    expect(tree.violations).toBe(0);
    // a broken ladder is detected, not silently coloured
    expect(buildRegionTree([[0, 0, 1, 1], [0, 1, 0, 1]])!.violations).toBeGreaterThan(0);
  });

  test("hue = ancestry: children stay inside the parent's hue neighbourhood; an unsplit region keeps its exact hue", () => {
    const hues = treeHues(tree, 0);
    // every child's hue is nearer its OWN parent than any other parent (refinement, not reroll)
    for (let l = 1; l < 3; l++) for (let r = 0; r < tree.counts[l]; r++) {
      const p = tree.parents[l][r];
      for (let q = 0; q < tree.counts[l - 1]; q++) if (q !== p) expect(hueDist(hues[l][r], hues[l - 1][p])).toBeLessThan(hueDist(hues[l][r], hues[l - 1][q]));
    }
    // region 1@L1 (= 2@L2) never splits: its hue is IDENTICAL at both grains
    expect(hueDist(hues[2][2], hues[1][2])).toBeLessThan(1e-9);
    // sibling guard gap: no two same-level hues coincide
    for (const lvl of hues) for (let i = 0; i < lvl.length; i++) for (let j = i + 1; j < lvl.length; j++) expect(hueDist(lvl[i], lvl[j])).toBeGreaterThan(0.5);
  });

  test("anchor rotation lands the largest top-level region on the theme's primary hue", () => {
    const anchor = anchorHueOf(THEMES.light);
    const hues = treeHues(tree, anchor);
    expect(hueDist(hues[0][0], anchor)).toBeLessThan(1e-9);   // region 0 is the largest (7 of 12)
  });

  test("tree palette: fixed hues survive the engine (chroma/lightness move, hue does not)", () => {
    const toOklch = converter("oklch") as any;
    for (const [name, tokens] of Object.entries(THEMES)) {
      const hues = treeHues(tree, anchorHueOf(tokens));
      for (let l = 0; l < 3; l++) {
        const d = treeThemePalette(`${name}-t${l}`, tree, l, tokens);
        expect(d).not.toBeNull();
        expect(d!.colors.length).toBe(tree.counts[l]);
        expect(d!.metrics.worstContrast).toBeGreaterThanOrEqual(2.9);
        d!.colors.forEach((c, r) => {
          const h = toOklch({ mode: "rgb", r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 }).h ?? 0;
          expect(hueDist(h, hues[l][r])).toBeLessThan(4);   // 8-bit quantization + clamp wobble only
        });
      }
    }
  });
});
