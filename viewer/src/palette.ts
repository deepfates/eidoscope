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
// REGION colours additionally follow the map's GRAIN TREE (buildRegionTree/treeHues/treeThemePalette
// below): hue = ancestry, so the grain slider refines colour instead of rerolling it. The flat
// spread-k ring below remains the path for categorical dimensions and ladder-less maps.
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
// REGION TREE → HUE SPANS (eid-yhj7, ruled 2026-08-10). Region colours follow the GRAIN TREE:
// the full hue ring [0,360) is owned by the root; each region owns a sub-span of its parent's span,
// subdivided among siblings proportional to member count; a region's hue is its span's centre. Hue is
// therefore determined by ANCESTRY — deepening the grain REFINES colour (children are related-but-
// distinct shades of the parent's neighbourhood) instead of rerolling it, and sibling similarity
// becomes information. Lightness tiers + the hill-climb (below) separate the hue-adjacent siblings.

export type RegionTree = {
  counts: number[];       // regions per level
  parents: number[][];    // parents[l][r] = parent region at level l-1 (level 0: -1)
  sizes: number[][];      // member count per region per level
  ordinal: number[][];    // position among same-parent siblings (drives the lightness tier)
  violations: number;     // nodes whose parent was inconsistent — 0 when the ladder truly nests
};

/** Derive the grain tree from the MapContract `levels` arrays (per level: per-node region id).
 *  The ladder is divisive, so every region at level l+1 sits inside exactly one region at level l;
 *  `violations` counts any node that breaks that (measured 0 on real maps — kept as a canary). */
export function buildRegionTree(levels: number[][]): RegionTree | null {
  if (!levels?.length || !levels[0]?.length) return null;
  const nL = levels.length, n = levels[0].length;
  const counts: number[] = [], parents: number[][] = [], sizes: number[][] = [];
  let violations = 0;
  for (let l = 0; l < nL; l++) {
    let k = 0; for (let i = 0; i < n; i++) if (levels[l][i] >= k) k = levels[l][i] + 1;
    counts.push(k);
    const sz = new Array<number>(k).fill(0), par = new Array<number>(k).fill(-1);
    for (let i = 0; i < n; i++) {
      const r = levels[l][i]; sz[r]++;
      if (l > 0) { const p = levels[l - 1][i]; if (par[r] === -1) par[r] = p; else if (par[r] !== p) violations++; }
    }
    sizes.push(sz); parents.push(par);
  }
  const ordinal = parents.map((par) => { const seen = new Map<number, number>(); return par.map((p) => { const o = seen.get(p) ?? 0; seen.set(p, o + 1); return o; }); });
  return { counts, parents, sizes, ordinal, violations };
}

// Subdivide a span among siblings proportional to size, each slot shrunk about its centre by
// s/(s+1) — so the guard gap between adjacent siblings is derived from the span and the sibling
// count (mean slot width / (s+1)), never an absolute constant. A lone child inherits the parent
// span exactly, which is what keeps an unsplit region's hue IDENTICAL across grain levels.
function subdivide(lo: number, width: number, sz: number[]): [number, number][] {
  const s = sz.length;
  if (s === 1) return [[lo, width]];
  const total = sz.reduce((a, b) => a + b, 0) || s;
  const out: [number, number][] = []; let cur = lo;
  for (const w of sz) {
    const slot = (width * (w || 1)) / total;
    out.push([cur + slot / (2 * (s + 1)), (slot * s) / (s + 1)]);
    cur += slot;
  }
  return out;
}

/** Ancestry-stable hues per level: span centres, with the whole ring rotated so the largest
 *  top-level region lands on `anchorHue` (the theme's primary token — keeps the theme-derived
 *  personality; deterministic). */
export function treeHues(tree: RegionTree, anchorHue: number): number[][] {
  const { counts, parents, sizes } = tree;
  const spans: [number, number][][] = [subdivide(0, 360, sizes[0])];
  for (let l = 1; l < counts.length; l++) {
    const lvl = new Array<[number, number]>(counts[l]);
    // children grouped per parent, in region-id order (deterministic: divisive ids are stable)
    const byParent = new Map<number, number[]>();
    for (let r = 0; r < counts[l]; r++) { const p = parents[l][r]; const a = byParent.get(p); if (a) a.push(r); else byParent.set(p, [r]); }
    for (const [p, kids] of byParent) {
      const [plo, pw] = spans[l - 1][p] ?? [0, 360];
      subdivide(plo, pw, kids.map((r) => sizes[l][r])).forEach((sp, i) => (lvl[kids[i]] = sp));
    }
    spans.push(lvl);
  }
  let big = 0; sizes[0].forEach((w, r) => { if (w > sizes[0][big]) big = r; });
  const [blo, bw] = spans[0][big];
  const delta = anchorHue - (blo + bw / 2);
  return spans.map((lvl) => lvl.map(([lo, w]) => (((lo + w / 2 + delta) % 360) + 360) % 360));
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

/** Hues fixed by the caller (the grain tree): the engine keeps the theme's chroma personality, the
 *  contrast-floor lightness band, the tier phase and the deuteranopia-weighted hill-climb — on L only. */
export type FixedHues = { hues: number[]; tiers?: number[] };

/** Generate the categorical palette for one theme's tokens. Returns null when the theme is unusable
 *  (tokens unparseable, or no lightness band clears a 2.0:1 floor) — the caller then falls back. */
export function derivePalette(theme: ThemeTokens, n = N, fixed?: FixedHues): Derived | null {
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

  // 3. hue set. FIXED path (region tree): the hues arrive pre-determined by ancestry — the engine
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

  // 4. a lightness band that clears the contrast floor against THIS canvas
  const okAt = (l: number, h: number, c = C) => ({ mode: "oklch" as const, l, c, h });
  const passes = (l: number, h: number) => wcagContrast(clampChroma(okAt(l, h), "oklch"), bgc as any) >= CONTRAST_FLOOR;
  let lo = dark ? 0.55 : 0.42, hi = dark ? 0.9 : 0.72;
  const worstH = dark ? 264 : 100;   // blue is darkest at equal L, yellow lightest
  for (let g = 0; g < 40 && !passes(dark ? lo : hi, worstH); g++) { if (dark) lo += 0.01; else hi -= 0.01; }
  if (hi - lo < 0.1) { const m = (hi + lo) / 2; lo = m - 0.05; hi = m + 0.05; }

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

// Tree-hue palettes are memoized per (tree, theme, level); trees are per-map objects, so a WeakMap
// lets an unloaded map's palettes be collected with it. The hue tree itself (spans + anchor rotation)
// is theme-dependent only through the anchor hue, so it is memoized per (tree, anchor).
const treeMemo = new WeakMap<RegionTree, Map<string, Derived | null>>();
const hueMemo = new WeakMap<RegionTree, Map<number, number[][]>>();
export function treeThemePalette(name: string, tree: RegionTree, level: number, tokens?: ThemeTokens): Derived | null {
  let m = treeMemo.get(tree); if (!m) treeMemo.set(tree, (m = new Map()));
  const key = `${name}:${level}`;
  if (m.has(key)) return m.get(key)!;
  if (!tokens) { tokens = tokenMemo.get(name) ?? readThemeTokens(); tokenMemo.set(name, tokens); }
  let d: Derived | null = null;
  try {
    const anchor = anchorHueOf(tokens);
    let hm = hueMemo.get(tree); if (!hm) hueMemo.set(tree, (hm = new Map()));
    let hues = hm.get(anchor); if (!hues) hm.set(anchor, (hues = treeHues(tree, anchor)));
    const lh = hues[level];
    if (lh) d = derivePalette(tokens, lh.length, { hues: lh, tiers: tree.ordinal[level] });
  } catch { d = null; }
  m.set(key, d);
  if (d) {
    const mm = d.metrics;
    console.info(`[eido] tree palette "${name}" level ${level} (${d.colors.length} regions): minΔEOK ${mm.minDEok.toFixed(4)} · deuter ${mm.minDEokDeuter.toFixed(4)} · contrast ${mm.worstContrast.toFixed(2)}:1`);
  }
  return d;
}
