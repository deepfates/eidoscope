import { expect, test, describe } from "bun:test";
import { derivePalette, type ThemeTokens } from "../viewer/src/palette";

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
