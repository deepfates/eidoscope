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
//
// REGION and CATEGORICAL colours additionally follow the map's COLOR COORDINATES (eid-zsij) when the
// file carries them: hue = the group's member-centroid angle on the colour disc (similar things wear
// similar hues, across every view), separated along the ring order-preservingly (separateHues below),
// then pushed through THIS engine's chroma personality + contrast band + deuteranopia hill-climb via
// the FixedHues path. The flat spread-k ring below survives as the fallback for files without colour
// coordinates. Scalar dimensions get theme-derived OKLCH ramps (viewer/src/encode.ts scalarRamp).
import { converter, clampChroma, wcagContrast, filterDeficiencyDeuter, parse } from "culori";
import { GRAIN_PALETTE_N } from "../../src/schema";

export type RGB = [number, number, number];
export type ThemeTokens = Record<string, string>;

const toOklch = converter("oklch") as (c: any) => any;
const toRgb = converter("rgb") as (c: any) => any;
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

// ---------------------------------------------------------------------------
// COLOR-COORDINATE HUES (eid-zsij, approved 2026-08-10). When the file carries per-card colour
// coordinates (a dedicated projection of the card vectors onto the unit disc), every group of cards
// — a region at any grain, a categorical value's members — wears the hue of its MEMBER CENTROID's
// angle on that disc. Similar groups sit near each other in card space, so they wear similar hues,
// in every view (neighbor map, axis scatter, 3D). Chroma + lightness never come from the disc: they
// come from THIS file's theme engine (chroma personality, contrast-floor band, deuteranopia
// hill-climb) through the FixedHues path, so full-strength theme colours are guaranteed.

/** Per-group centroid angle (degrees, 0..360) of the members' colour coordinates. Groups with no
 *  members get 0 — they never render, so any value is inert. `assign[i]` < 0 = card in no group. */
export function centroidHues(coords: number[][], assign: ArrayLike<number>, k: number): number[] {
  const cx = new Array<number>(k).fill(0), cy = new Array<number>(k).fill(0), cn = new Array<number>(k).fill(0);
  for (let i = 0; i < coords.length; i++) {
    const g = assign[i]; if (g == null || g < 0 || g >= k) continue;
    cx[g] += coords[i][0]; cy[g] += coords[i][1]; cn[g]++;
  }
  return Array.from({ length: k }, (_, g) => (cn[g] ? ((Math.atan2(cy[g] / cn[g], cx[g] / cn[g]) * 180) / Math.PI + 360) % 360 : 0));
}

/** Order-preserving circular separation: move hues along the ring — NEVER reorder them — so that
 *  every adjacent circular gap is ≥ gmin degrees. Similar groups stay adjacent on the ring (the
 *  similarity signal survives); identical/near-identical centroid angles become distinguishable.
 *  EXACT, not iterative: with k hues, k·gmin ≤ 360 is feasible and the construction below provably
 *  meets the gap; when k·gmin > 360 no placement can honor gmin, so the honest achievable gap —
 *  exactly 360/k (equal spacing) — is used instead of pretending. Deterministic throughout
 *  (stable sort; coincident hues keep their input-index order). */
export function separateHues(hues: number[], gmin: number): number[] {
  const k = hues.length;
  if (k < 2 || gmin <= 0) return hues.slice();
  const g = Math.min(gmin, 360 / k);   // the honest achievable gap
  const idx = hues.map((_, i) => i).sort((a, b) => hues[a] - hues[b]);   // stable: ties keep input order
  const a = idx.map((i) => hues[i]);
  // Adjacent circular gaps of the sorted ring, and the sweep start s (gas-station argument): with
  // slack e_j = gap_j − g and prefix sums P, start just past M = argmax P. Then every cyclic gap
  // interval ENDING at M has nonneg slack (inside: P_M − P_{i−1} ≥ 0 since P_M is the max; wrapping:
  // add the total slack P_{k−1} = 360 − k·g ≥ 0), which is exactly the condition for the single
  // forward sweep below to close the ring: its last→first gap is provably ≥ g.
  const gap = a.map((_, j) => (j === k - 1 ? a[0] + 360 - a[j] : a[j + 1] - a[j]));
  let s = 0, run = 0, best = -Infinity;
  for (let j = 0; j < k; j++) { run += gap[j] - g; if (run > best) { best = run; s = (j + 1) % k; } }
  // Unwrap the ring into a nondecreasing line starting at s, then one forward pass
  // d[t] = max(c[t], d[t−1] + g): each hue moves only clockwise, order is preserved by construction,
  // every interior gap is ≥ g exactly, and the start choice bounds the final push so that
  // c[0] + 360 − d[k−1] ≥ g (the closing gap).
  const c = Array.from({ length: k }, (_, t) => a[(s + t) % k] + (s + t >= k ? 360 : 0));
  const d = new Array<number>(k);
  d[0] = c[0];
  for (let t = 1; t < k; t++) d[t] = Math.max(c[t], d[t - 1] + g);
  const out = new Array<number>(k);
  for (let t = 0; t < k; t++) out[idx[(s + t) % k]] = ((d[t] % 360) + 360) % 360;
  return out;
}

/** The full recipe: member-centroid hues → order-preserving separation → the theme engine with hues
 *  PINNED (FixedHues: chroma personality, contrast band, deuteranopia hill-climb on L only).
 *  Lightness tiers phase-rotate along the ring's hue ORDER — hue-adjacent groups land on different
 *  tiers, which is exactly where separation is needed. Null when the theme's tokens are unusable. */
export function coordPalette(theme: ThemeTokens, coords: number[][], assign: ArrayLike<number>, k: number): Derived | null {
  const raw = centroidHues(coords, assign, k);
  // hue-gap floor: 10° of real separation, capped at 80% of equal spacing so it stays achievable
  const gmin = Math.min(10, 0.8 * (360 / k));
  const sep = separateHues(raw, gmin);
  const rank = new Array<number>(k);
  sep.map((h, g) => [h, g] as const).sort((p, q) => p[0] - q[0]).forEach(([, g], j) => (rank[g] = j));
  return derivePalette(theme, k, { hues: sep, tiers: rank.map((j) => (j * 2) % 3) });
}

/** The theme's primary-token hue (falling back through the chromatic tokens; 0 if achromatic). */
export function anchorHueOf(theme: ThemeTokens): number {
  for (const k of HUE_KEYS) {
    const raw = theme[k]; if (!raw) continue;
    const p = parse(raw); if (!p) continue;
    const c: any = toOklch(p as any);
    if ((c.c ?? 0) >= 0.04 && c.h != null) return c.h;
  }
  return 0;
}

/** Hues fixed by the caller (coordPalette's centroid hues): the engine keeps the theme's chroma personality, the
 *  contrast-floor lightness band, the tier phase and the deuteranopia-weighted hill-climb — on L only. */
export type FixedHues = { hues: number[]; tiers?: number[] };

/** Generate the categorical palette for one theme's tokens. Returns null when the theme is unusable
 *  (tokens unparseable, or no lightness band clears a 2.0:1 floor) — the caller then falls back. */
export function derivePalette(theme: ThemeTokens, n = N, fixed?: FixedHues): Derived | null {
  const bgc: any = theme["base-100"] ? toOklch(parse(theme["base-100"]) as any) ?? null : null;
  if (!bgc || !Number.isFinite(bgc.l)) return null;
  const inkc: any = theme["base-content"] ? toOklch(parse(theme["base-content"]) as any) ?? null : null;

  // 1. anchors: the theme's chromatic tokens, deduped so near-identical hues don't crowd the ring
  const anchors: number[] = [];
  for (const k of HUE_KEYS) {
    const raw = theme[k]; if (!raw) continue;
    const p = parse(raw); if (!p) continue;
    const c: any = toOklch(p as any);
    if ((c.c ?? 0) < 0.04 || c.h == null) continue;   // achromatic token carries no hue signal
    if (!anchors.some((h) => Math.abs(((h - c.h! + 540) % 360) - 180) > 165)) anchors.push(c.h!);
  }
  // 2+4. theme "personality" chroma + the contrast-floor lightness band — ONE implementation,
  // shared with the scalar ramps (themeGamut below)
  const g = themeGamut(theme)!;   // bgc parsed above, so this cannot be null
  const { C, dark } = g;

  // 3. hue set. FIXED path (colour-coordinate centroids): the hues arrive pre-determined — the engine
  //    must not move them. FLAT path (categorical dims, fallback): keep the anchors, fill the rest
  //    by repeatedly splitting the largest circular gap.
  let hues: number[];
  if (fixed) {
    hues = fixed.hues; n = hues.length;
  } else {
    hues = [...anchors].sort((a, b) => a - b);
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
  }

  // (band computed by themeGamut above)
  const { lo, hi } = g;

  // 5. three lightness tiers: a lightness channel that survives dichromacy (hue collapses under
  //    deuteranopia, lightness does not). FLAT path: phase-rotated across the hue ring. FIXED path:
  //    the tier index is the region's ordinal AMONG ITS SIBLINGS — siblings share a hue
  //    neighbourhood by construction, so the tiers are aimed exactly at separating them.
  const tiers = [lo + (hi - lo) * 0.12, (lo + hi) / 2, lo + (hi - lo) * 0.88];
  const out: any[] = hues.map((h, i) => {
    const yellowness = Math.cos(((h - 100) * Math.PI) / 180);   // yellows sit high in L naturally, blues low
    const ti = fixed?.tiers ? fixed.tiers[i] % 3 : (i * 2) % 3;
    const l0 = tiers[ti] + yellowness * (hi - lo) * 0.06;
    const l = Math.min(hi, Math.max(lo, l0));
    const c = C * (0.85 + 0.15 * Math.abs(Math.sin((h * Math.PI) / 180)));
    return clampChroma({ mode: "oklch" as const, l, c, h }, "oklch");
  });

  // 6. deterministic local hill-climb on L within the band (hues stay FIXED — only lightness moves),
  //    maximising the min pairwise ΔE (normal vision AND deuteranope, the latter weighted so it can't
  //    be traded away). Colours are cached as oklab pairs so scoring is arithmetic, not conversion.
  //    At fine grains n reaches the hundreds; global all-pairs scoring is O(n²) per candidate, so past
  //    a small n each colour is scored against its plausible confusers only: its neighbours in hue
  //    order (siblings and adjacent spans — the closest colours by construction) UNION its neighbours
  //    in deuteranope-hue order (red–green collapse confuses hue-DISTANT colours; hue order alone
  //    would miss them). The window spans both lightness-tier neighbours on each side.
  const toLab = converter("oklab") as (c: any) => any;
  const lab = out.map((c) => toLab(c)), dlab = out.map((c) => toLab(deuter(c)));
  const d2 = (a: any, b: any) => { const dl = a.l - b.l, da = (a.a ?? 0) - (b.a ?? 0), db = (a.b ?? 0) - (b.b ?? 0); return dl * dl + da * da + db * db; };
  const rivals: number[][] = [];
  const WIN = 8;   // neighbours per side per ordering; small-n palettes fall back to all-pairs
  if (n > 4 * WIN) {
    const hueOf = (c: any) => toOklch(c).h ?? 0;
    const byHue = out.map((_, i) => i).sort((a, b) => hueOf(out[a]) - hueOf(out[b]));
    const byDHue = out.map((_, i) => i).sort((a, b) => hueOf(deuter(out[a])) - hueOf(deuter(out[b])));
    const posH = new Array<number>(n), posD = new Array<number>(n);
    byHue.forEach((v, p) => (posH[v] = p)); byDHue.forEach((v, p) => (posD[v] = p));
    for (let i = 0; i < n; i++) {
      const set = new Set<number>();
      for (let o = -WIN; o <= WIN; o++) {
        if (!o) continue;
        set.add(byHue[(posH[i] + o + n) % n]); set.add(byDHue[(posD[i] + o + n) % n]);
      }
      set.delete(i); rivals.push([...set]);
    }
  } else for (let i = 0; i < n; i++) rivals.push(out.map((_, j) => j).filter((j) => j !== i));
  const nPasses = n > 4 * WIN ? 20 : 60;   // windowed scoring converges in fewer, cheaper passes
  for (let pass = 0; pass < nPasses; pass++) {
    for (let i = 0; i < out.length; i++) {
      let best = out[i], bestScore = -1, bestLab = lab[i], bestDLab = dlab[i];
      for (const dl of [-0.03, -0.015, 0, 0.015, 0.03]) {
        const cur: any = toOklch(out[i]);
        const cand = clampChroma({ ...cur, l: Math.min(hi, Math.max(lo, cur.l + dl)) } as any, "oklch")!;
        if (wcagContrast(cand, bgc as any) < CONTRAST_FLOOR) continue;
        const cl = toLab(cand), cd = toLab(deuter(cand));
        let s = Infinity, sd = Infinity;
        for (const j of rivals[i]) { s = Math.min(s, d2(cl, lab[j])); sd = Math.min(sd, d2(cd, dlab[j])); }
        s = Math.min(Math.sqrt(s), Math.sqrt(sd) * 2.2);
        if (s > bestScore) { bestScore = s; best = cand; bestLab = cl; bestDLab = cd; }
      }
      out[i] = best; lab[i] = bestLab; dlab[i] = bestDLab;
    }
  }

  // 7. canary metrics — measured, not asserted. A pathological custom theme that can't clear even a
  //    degenerate 2.0:1 floor is rejected here so the caller can fall back to the fixed palette.
  let minDEok = Infinity, minDEokDeuter = Infinity, worstContrast = Infinity;
  for (let i = 0; i < out.length; i++) {
    worstContrast = Math.min(worstContrast, wcagContrast(out[i], bgc as any));
    for (let j = i + 1; j < out.length; j++) {
      minDEok = Math.min(minDEok, d2(lab[i], lab[j]));
      minDEokDeuter = Math.min(minDEokDeuter, d2(dlab[i], dlab[j]));
    }
  }
  minDEok = Math.sqrt(minDEok); minDEokDeuter = Math.sqrt(minDEokDeuter);
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

/** The live theme's tokens by data-theme name, memoized (read off the DOM once per theme). */
export function themeTokensOf(name: string): ThemeTokens {
  let t = tokenMemo.get(name);
  if (!t) { t = readThemeTokens(); tokenMemo.set(name, t); }
  return t;
}

// ---------------------------------------------------------------------------
// THEME GAMUT for scalar ramps (eid-zsij): the same personality-chroma + contrast-floor lightness
// band derivePalette computes, exposed as numbers so encode.ts can build monotone-lightness and
// diverging OKLCH ramps from them (the Viridis carve-out's replacement).
export type Gamut = { C: number; lo: number; hi: number; dark: boolean; anchor: number };
export function themeGamut(theme: ThemeTokens): Gamut | null {
  const bgc: any = theme["base-100"] ? toOklch(parse(theme["base-100"]) as any) ?? null : null;
  if (!bgc || !Number.isFinite(bgc.l)) return null;
  const dark = bgc.l < 0.5;
  const chromas: number[] = [];
  for (const k of HUE_KEYS) {
    const raw = theme[k]; if (!raw) continue;
    const p = parse(raw); if (!p) continue;
    const c: any = toOklch(p as any);
    if ((c.c ?? 0) >= 0.04 && c.h != null) chromas.push(c.c!);
  }
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  const C = Math.min(0.19, Math.max(0.085, median(chromas) || 0.14));
  const passes = (l: number, h: number) => wcagContrast(clampChroma({ mode: "oklch" as const, l, c: C, h }, "oklch"), bgc as any) >= CONTRAST_FLOOR;
  let lo = dark ? 0.55 : 0.42, hi = dark ? 0.9 : 0.72;
  const worstH = dark ? 264 : 100;
  for (let g = 0; g < 40 && !passes(dark ? lo : hi, worstH); g++) { if (dark) lo += 0.01; else hi -= 0.01; }
  if (hi - lo < 0.1) { const m = (hi + lo) / 2; lo = m - 0.05; hi = m + 0.05; }
  return { C, lo, hi, dark, anchor: anchorHueOf(theme) };
}

/** One OKLCH colour → 0-255 RGB, chroma-clamped into gamut (the ramp builders' pixel step). */
export const oklchToRgb = (l: number, c: number, h: number): RGB => rgb255({ mode: "oklch" as const, l, c, h });
