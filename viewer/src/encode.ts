import { schemeTableau10, interpolateSinebow, interpolateViridis } from "d3-scale-chromatic";
import { rgb } from "d3-color";
import { themePalette, type RGB } from "./palette";

// Encodings: how a card's region/metadata/axis-position becomes colour and size. Kept out of the render
// core so the control panel + legend and the deck layers share ONE source of truth for what a colour means.

export type { RGB };
// Categorical palette: DERIVED FROM THE LIVE THEME (see palette.ts) so the map's ink and the chrome's
// theme are one colour system. The fixed Tableau-10 + Sinebow ramp below stays as the FALLBACK for a
// pathological custom theme whose tokens can't yield a legible band.
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
// bumps paletteVer so reactive readers and deck updateTriggers can invalidate off ONE number.
let activeTheme = "";
// The palette is sized to the categorical count actually on the colour channel (region count at the
// current grain, or a categorical dimension's value count) — set reactively by App. No fixed size,
// no modulo recycling: every region gets its own colour, as separated as the engine can make k of them.
let paletteK = 24;
export let paletteVer = 0;
export const palette = (name: string = activeTheme): RGB[] => (name ? themePalette(name, undefined, paletteK)?.colors ?? PALX : PALX);
export function setActiveTheme(name: string): number {
  if (name === activeTheme) return paletteVer;
  activeTheme = name;
  themePalette(name, undefined, paletteK);   // generate + log the canary metrics now, while the DOM carries this theme
  return ++paletteVer;
}
export function setPaletteK(k: number): number {
  const kk = Math.max(2, Math.floor(k) || 2);
  if (kk === paletteK) return paletteVer;
  paletteK = kk;
  if (activeTheme) themePalette(activeTheme, undefined, kk);
  return ++paletteVer;
}
export const activeThemeName = () => activeTheme;
// index directly — ids at the current grain are < k by construction; modulo survives only as a guard
// for out-of-band callers (ghost/legend edge ids), never as the sizing mechanism.
export const col = (c: number): RGB => { const p = palette(); return p[((c % p.length) + p.length) % p.length]; };
// continuous axis gradient (low → high) = Viridis, the ecosystem-standard perceptually-uniform,
// colourblind-friendly sequential scale. Deliberately NOT theme-derived: most themes' tokens make a
// degenerate (non-monotone, low-range) ramp, and a dishonest ramp is worse than an off-palette one.
export const axisColor = (t: number): RGB => toRGB(interpolateViridis(Math.max(0, Math.min(1, t))));
