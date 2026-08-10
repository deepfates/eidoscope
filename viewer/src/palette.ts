// THEME-DERIVED MAP PALETTE (eid-caza).
//
// The map used to paint regions with a fixed Tableau-10+Sinebow ramp while the CHROME wore a DaisyUI theme —
// two colour systems in one window, and on a light or violet ground the fixed ramp went muddy or invisible.
// Here the categorical palette is DERIVED from the live theme's own tokens: the theme's chromatic tokens seed
// the hue ring, the theme's median chroma sets the saturation "personality", and the lightness band is pushed
// until every colour clears a contrast floor against THIS canvas. Measured across all 35 stock DaisyUI themes
// this beats the incumbent fixed palette on min ΔE(OKLab), on deuteranope min ΔE, and on background contrast.
//
// The generator is pure (tokens in → colours out) so it is unit-testable; readThemeTokens() is the only part
// that touches the DOM. Callers memoize per data-theme name via themePalette().
import { converter, clampChroma, wcagContrast, differenceEuclidean, filterDeficiencyDeuter, parse } from "culori";
import { GRAIN_PALETTE_N } from "../../src/schema";

export type RGB = [number, number, number];
export type ThemeTokens = Record<string, string>;

const toOklch = converter("oklch") as (c: any) => any;
const toRgb = converter("rgb") as (c: any) => any;
const dEok = differenceEuclidean("oklab");
const deuter = filterDeficiencyDeuter(1);

const rgb255 = (c: any): RGB => {
  const r = toRgb(clampChroma(c, "oklch"));
  return [Math.round(Math.max(0, Math.min(1, r.r)) * 255), Math.round(Math.max(0, Math.min(1, r.g)) * 255), Math.round(Math.max(0, Math.min(1, r.b)) * 255)];
};

const N = GRAIN_PALETTE_N;   // shared with the pipeline: the default grain is the finest level that fits this palette
const CONTRAST_FLOOR = 3.0;   // WCAG non-text contrast against the canvas
const HUE_KEYS = ["primary", "secondary", "accent", "info", "success", "warning", "error", "neutral"];
// The token names read off <html data-theme> — DaisyUI 5 publishes them as CSS custom properties.
export const TOKEN_KEYS = ["base-100", "base-200", "base-300", "base-content", ...HUE_KEYS];

export type Derived = {
  colors: RGB[];
  dark: boolean;
  bg: RGB;            // base-100, the canvas
  ink: RGB;           // base-content, the map's text/spoke ink
  metrics: { minDEok: number; minDEokDeuter: number; worstContrast: number };
};

/** Generate the categorical palette for one theme's tokens. Returns null when the theme is unusable
 *  (tokens unparseable, or no lightness band clears a 2.0:1 floor) — the caller then falls back. */
export function derivePalette(theme: ThemeTokens, n = N): Derived | null {
  const bgc: any = theme["base-100"] ? toOklch(parse(theme["base-100"]) as any) ?? null : null;
  if (!bgc || !Number.isFinite(bgc.l)) return null;
  const inkc: any = theme["base-content"] ? toOklch(parse(theme["base-content"]) as any) ?? null : null;
  const dark = bgc.l < 0.5;

  // 1. anchors: the theme's chromatic tokens, deduped so near-identical hues don't crowd the ring
  const anchors: number[] = [];
  const chromas: number[] = [];
  for (const k of HUE_KEYS) {
    const raw = theme[k]; if (!raw) continue;
    const p = parse(raw); if (!p) continue;
    const c: any = toOklch(p as any);
    if ((c.c ?? 0) < 0.04 || c.h == null) continue;   // achromatic token carries no hue signal
    chromas.push(c.c!);
    if (!anchors.some((h) => Math.abs(((h - c.h! + 540) % 360) - 180) > 165)) anchors.push(c.h!);
  }
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  // 2. theme "personality": its own chroma level, clamped so it never goes muddy or neon-unreadable
  const C = Math.min(0.19, Math.max(0.085, median(chromas) || 0.14));

  // 3. hue set: keep the anchors, fill the rest by repeatedly splitting the largest circular gap
  const hues = [...anchors].sort((a, b) => a - b);
  if (!hues.length) for (let i = 0; i < 6; i++) hues.push(i * 60);   // achromatic theme → neutral seed ring
  while (hues.length < n) {
    let bi = 0, big = -1;
    for (let i = 0; i < hues.length; i++) {
      const g = (hues[(i + 1) % hues.length] - hues[i] + 360) % 360 || 360;
      if (g > big) { big = g; bi = i; }
    }
    hues.splice(bi + 1, 0, (hues[bi] + big / 2) % 360);
  }
  hues.length = n;

  // 4. a lightness band that clears the contrast floor against THIS canvas
  const okAt = (l: number, h: number, c = C) => ({ mode: "oklch" as const, l, c, h });
  const passes = (l: number, h: number) => wcagContrast(clampChroma(okAt(l, h), "oklch"), bgc as any) >= CONTRAST_FLOOR;
  let lo = dark ? 0.55 : 0.42, hi = dark ? 0.9 : 0.72;
  const worstH = dark ? 264 : 100;   // blue is darkest at equal L, yellow lightest
  for (let g = 0; g < 40 && !passes(dark ? lo : hi, worstH); g++) { if (dark) lo += 0.01; else hi -= 0.01; }
  if (hi - lo < 0.1) { const m = (hi + lo) / 2; lo = m - 0.05; hi = m + 0.05; }

  // 5. three lightness tiers phase-rotated across the hue ring: a lightness channel that survives
  //    dichromacy (hue collapses under deuteranopia, lightness does not)
  const tiers = [lo + (hi - lo) * 0.12, (lo + hi) / 2, lo + (hi - lo) * 0.88];
  const out: any[] = hues.map((h, i) => {
    const yellowness = Math.cos(((h - 100) * Math.PI) / 180);   // yellows sit high in L naturally, blues low
    const l0 = tiers[(i * 2) % 3] + yellowness * (hi - lo) * 0.06;
    const l = Math.min(hi, Math.max(lo, l0));
    const c = C * (0.85 + 0.15 * Math.abs(Math.sin((h * Math.PI) / 180)));
    return clampChroma({ mode: "oklch" as const, l, c, h }, "oklch");
  });

  // 6. deterministic local hill-climb on L within the band, maximising the min pairwise ΔE
  //    (normal vision AND deuteranope, the latter weighted so it can't be traded away)
  for (let pass = 0; pass < 60; pass++) {
    for (let i = 0; i < out.length; i++) {
      let best = out[i], bestScore = -1;
      for (const dl of [-0.03, -0.015, 0, 0.015, 0.03]) {
        const cur: any = toOklch(out[i]);
        const cand = clampChroma({ ...cur, l: Math.min(hi, Math.max(lo, cur.l + dl)) } as any, "oklch")!;
        if (wcagContrast(cand, bgc as any) < CONTRAST_FLOOR) continue;
        let s = Infinity, sd = Infinity; const cd = deuter(cand);
        for (let j = 0; j < out.length; j++) if (j !== i) { s = Math.min(s, dEok(cand, out[j])); sd = Math.min(sd, dEok(cd, deuter(out[j]))); }
        s = Math.min(s, sd * 2.2);
        if (s > bestScore) { bestScore = s; best = cand; }
      }
      out[i] = best;
    }
  }

  // 7. canary metrics — measured, not asserted. A pathological custom theme that can't clear even a
  //    degenerate 2.0:1 floor is rejected here so the caller can fall back to the fixed palette.
  let minDEok = Infinity, minDEokDeuter = Infinity, worstContrast = Infinity;
  for (let i = 0; i < out.length; i++) {
    worstContrast = Math.min(worstContrast, wcagContrast(out[i], bgc as any));
    for (let j = i + 1; j < out.length; j++) {
      minDEok = Math.min(minDEok, dEok(out[i], out[j]));
      minDEokDeuter = Math.min(minDEokDeuter, dEok(deuter(out[i]), deuter(out[j])));
    }
  }
  if (!Number.isFinite(worstContrast) || worstContrast < 2.0) return null;

  return {
    colors: out.map(rgb255),
    dark,
    bg: rgb255(bgc),
    ink: inkc ? rgb255(inkc) : (dark ? [235, 235, 240] : [30, 30, 40]),
    metrics: { minDEok, minDEokDeuter, worstContrast },
  };
}

/** Read the LIVE theme's tokens off the document (after data-theme has been stamped). */
export function readThemeTokens(el: Element = document.documentElement): ThemeTokens {
  const cs = getComputedStyle(el);
  const t: ThemeTokens = {};
  for (const k of TOKEN_KEYS) {
    const v = cs.getPropertyValue("--color-" + k).trim();
    if (v) t[k] = v;
  }
  return t;
}

// One generation per data-theme name, for the life of the page. A miss (null) is cached too, so a
// pathological theme doesn't re-run the hill-climb on every repaint.
// One generation per (theme, size), for the life of the page: the palette is sized to the REGION
// COUNT actually on screen (deepfates 2026-08-10 — a fixed 24 was a magic number wearing a haircut:
// coarse grains got an adjacent-hue prefix that read as a gradient, and fine grains recycled colours
// by modulo, dressing far-apart regions in identical ink). The engine always generated n colours;
// now n is the truth of the current grain. A miss (null) is cached so a pathological theme doesn't
// re-run the hill-climb on every repaint.
const memo = new Map<string, Derived | null>();
const tokenMemo = new Map<string, ThemeTokens>();
export function themePalette(name: string, tokens?: ThemeTokens, n: number = N): Derived | null {
  const key = `${name}:${n}`;
  if (memo.has(key)) return memo.get(key)!;
  if (!tokens) { tokens = tokenMemo.get(name) ?? readThemeTokens(); tokenMemo.set(name, tokens); }
  let d: Derived | null = null;
  try { d = derivePalette(tokens, n); } catch { d = null; }
  memo.set(key, d);
  if (d) {
    const m = d.metrics;
    console.info(`[eido] palette "${name}" (${n} colours): minΔEOK ${m.minDEok.toFixed(4)} · deuter ${m.minDEokDeuter.toFixed(4)} · contrast ${m.worstContrast.toFixed(2)}:1 · ${d.dark ? "dark" : "light"} ground`);
  } else {
    console.info(`[eido] palette "${name}": theme tokens unusable — falling back to the fixed palette`);
  }
  return d;
}
export const _resetPaletteMemo = () => memo.clear();   // tests only
