import { schemeTableau10, interpolateSinebow } from "d3-scale-chromatic";
import { rgb } from "d3-color";
import { themePalette, coordPalette, themeGamut, themeTokensOf, oklchToRgb, type Gamut, type RGB } from "./palette";

// Encodings: how a card's region/metadata/axis-position becomes colour and size. Kept out of the render
// core so the control panel + legend and the deck layers share ONE source of truth for what a colour means.
//
// ONE colour system (eid-zsij, approved 2026-08-10). The theme derives the gamut (palette.ts); the
// engine mints per-card COLOR COORDINATES (a dedicated projection of the card vectors onto the unit
// disc, carried in the .eido); every aggregate wears its members' colour centre:
//   · region at any grain      → hue = member-centroid angle, order-preserving ΔE separation
//   · categorical value        → the same recipe over the value's members
//   · scalar dimension         → theme-derived monotone-lightness OKLCH ramp
//   · bipolar (discovered) axis→ diverging ramp whose pole hues are the colour centres of the
//                                top/bottom-decile cards on that axis
// A file without colour coordinates (foreign/hand-built) falls back to the spread-k themed ring.

export type { RGB };
// The fixed Tableau-10 + Sinebow ramp stays ONLY as the fallback for a pathological custom theme
// whose tokens can't yield a legible band (derivePalette returns null).
const toRGB = (s: string): RGB => { const c = rgb(s); return [Math.round(c.r), Math.round(c.g), Math.round(c.b)]; };
export const PAL: RGB[] = schemeTableau10.map(toRGB);
export const PALX: RGB[] = (() => {
  const out: RGB[] = PAL.map((c) => [...c] as RGB);
  const tail = 24 - out.length;
  for (let i = 0; i < tail; i++) out.push(toRGB(interpolateSinebow((i + 0.5) / tail)));
  return out;
})();

// The active theme is module-level rather than threaded through every call site: colour is a global
// property of the page, and `col(c)` is called from deck accessors, legend rows and hover chips alike.
// setActiveTheme() is called once per theme switch (App.svelte, right after data-theme is stamped) and
// returns a version number so reactive readers and deck updateTriggers can invalidate off ONE value.
//
// `paletteVer` is deliberately NOT exported. It used to be (`export let` on a mutable counter — a live
// binding a consumer can read but never subscribe to), and nothing ever imported it: every call site uses
// the number the setters RETURN, which is the same value delivered at the moment it changes rather than
// whenever the reader happens to look. The export was a footgun describing a mechanism no one used.
let activeTheme = "";
let paletteVer = 0;

// The current map's colour coordinates (null = file carries none → spread-k fallback), and the
// current colour-channel GROUPS: per-card group index (region id at the live grain, or a categorical
// value index; < 0 = no group) with the group count. setColorGroups() recomputes the palette from
// these; everything else just reads `col(c)`.
let colorCoords: number[][] | null = null;
let groups: ArrayLike<number> | null = null;
let groupK = 24;
let colors: RGB[] | null = null;   // the computed palette for (theme, coords, groups, k)

function rebuild(): void {
  colors = null;
  if (!activeTheme) return;
  if (colorCoords && groups) {
    const d = coordPalette(themeTokensOf(activeTheme), colorCoords, groups, groupK);
    if (d) {
      const m = d.metrics;
      console.info(`[eido] coord palette "${activeTheme}" (${groupK} groups): minΔEOK ${m.minDEok.toFixed(4)} · deuter ${m.minDEokDeuter.toFixed(4)} · contrast ${m.worstContrast.toFixed(2)}:1`);
      colors = d.colors;
      return;
    }
  }
  colors = themePalette(activeTheme, undefined, groupK)?.colors ?? null;   // spread-k ring (no coords / unusable theme)
}

export const palette = (): RGB[] => colors ?? PALX;
export function setActiveTheme(name: string): number {
  if (name === activeTheme) return paletteVer;
  activeTheme = name;
  rampMemo = new WeakMap();
  rebuild();
  return ++paletteVer;
}
/** Hand the current map's colour coordinates to the colour engine (undefined = none / map closed). */
export function setColorData(coords?: number[][]): number {
  if ((coords ?? null) === colorCoords) return paletteVer;
  colorCoords = coords ?? null;
  rampMemo = new WeakMap();
  rebuild();
  return ++paletteVer;
}
/** The colour channel's group assignment: per-card group index + group count. Region colouring
 *  passes the grain's region assignment; a categorical dimension passes its value indices. */
export function setColorGroups(assign: ArrayLike<number> | undefined, k: number): number {
  const kk = Math.max(1, Math.floor(k) || 1);
  if ((assign ?? null) === groups && kk === groupK) return paletteVer;
  groups = assign ?? null; groupK = kk;
  rebuild();
  return ++paletteVer;
}
export const activeThemeName = () => activeTheme;
// index directly — ids at the current grain are < k by construction; modulo survives only as a guard
// for out-of-band callers (ghost/legend edge ids), never as the sizing mechanism.
export const col = (c: number): RGB => { const p = palette(); return p[((c % p.length) + p.length) % p.length]; };

// ---------------------------------------------------------------------------
// SCALAR RAMPS — theme-derived OKLCH, replacing the Viridis carve-out (eid-zsij).
//
// Monotonic dimensions (metrics, queries, derived): monotone LIGHTNESS through the theme's own hue
// neighbourhood (the anchor hue) — low values sit at the band's bg-near end, high values at the
// far end, chroma growing with value so "more" reads as more ink in every theme.
//
// Bipolar (discovered) axes: a DIVERGING ramp. The two pole hues are the colour-coordinate centroids
// of the top/bottom-decile cards on that axis — the poles wear their own members' colours, the same
// law as regions. Lightness is symmetric about the middle; the neutral middle keeps a low-chroma
// tint (25% of the theme's chroma personality) so it stays distinguishable from disabled/greyed UI
// ink, and recedes toward the band's bg-near end (a neutral middle should carry the least emphasis).
// Without colour coordinates the poles fall back to the anchor hue and its complement — still
// theme-derived, never Viridis.
const gamutMemo = new Map<string, Gamut | null>();
function gamutOf(): Gamut | null {
  if (!activeTheme) return null;
  let g = gamutMemo.get(activeTheme);
  if (g === undefined) { g = themeGamut(themeTokensOf(activeTheme)); gamutMemo.set(activeTheme, g); }
  return g;
}
const FALLBACK_RAMP = (t: number): RGB => {   // pathological theme: grey lightness ramp, still monotone
  const v = Math.round(60 + 160 * Math.max(0, Math.min(1, t)));
  return [v, v, v];
};
const hueOfCentroid = (idxs: number[]): number => {
  let x = 0, y = 0;
  for (const i of idxs) { x += colorCoords![i][0]; y += colorCoords![i][1]; }
  return ((Math.atan2(y / (idxs.length || 1), x / (idxs.length || 1)) * 180) / Math.PI + 360) % 360;
};

// Memoized per (scores array identity, bipolar) per theme — scores01 returns a cached array per
// (dimension, props), so identity is a real key. Cleared on theme/coords change.
let rampMemo = new WeakMap<object, Map<string, (t: number) => RGB>>();
export function scalarRamp(scores: number[] | undefined, bipolar: boolean): (t: number) => RGB {
  const g = gamutOf();
  if (!g) return FALLBACK_RAMP;
  const memoKey = (scores as object) ?? PAL;
  let byKind = rampMemo.get(memoKey); if (!byKind) rampMemo.set(memoKey, (byKind = new Map()));
  const key = `${activeTheme}:${bipolar ? "div" : "mono"}`;
  const hit = byKind.get(key); if (hit) return hit;
  const { C, lo, hi, dark, anchor } = g;
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  let ramp: (t: number) => RGB;
  if (!bipolar) {
    // monotone lightness: bg-near end → far end (dark ground brightens upward, light ground darkens)
    ramp = (t0: number) => {
      const t = clamp01(t0);
      const L = dark ? lo + t * (hi - lo) : hi - t * (hi - lo);
      return oklchToRgb(L, C * (0.45 + 0.55 * t), anchor);
    };
  } else {
    // pole hues from the axis's OWN members' colour centres (top/bottom decile by score)
    let hLo = anchor, hHi = (anchor + 180) % 360;
    if (colorCoords && scores?.length) {
      const order = scores.map((v, i) => i).sort((a, b) => scores[a] - scores[b]);
      const dec = Math.max(1, Math.floor(order.length / 10));
      hLo = hueOfCentroid(order.slice(0, dec));
      hHi = hueOfCentroid(order.slice(-dec));
    }
    const Lp = (lo + hi) / 2;   // poles sit mid-band (full chroma carries them); middle recedes bg-ward
    ramp = (t0: number) => {
      const t = clamp01(t0);
      const s = Math.abs(t - 0.5) * 2;   // 0 = neutral middle → 1 = pole
      const L = dark ? Lp - (1 - s) * (Lp - lo) * 0.7 : Lp + (1 - s) * (hi - Lp) * 0.7;
      return oklchToRgb(L, C * (0.25 + 0.75 * s), t < 0.5 ? hLo : hHi);
    };
  }
  byKind.set(key, ramp);
  return ramp;
}
