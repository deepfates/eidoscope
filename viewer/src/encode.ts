import { schemeTableau10, interpolateSinebow, interpolateViridis } from "d3-scale-chromatic";
import { rgb } from "d3-color";
import { themePalette, treeThemePalette, buildRegionTree, type RegionTree, type RGB } from "./palette";

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
// REGION-TREE COLOUR MODE (eid-yhj7): when the colour channel shows regions and the map carries a
// nested grain ladder, hues come from the GRAIN TREE (ancestry-stable across grain levels) rather
// than the spread-k ring. Categorical dims (no tree) keep the spread-k path below.
let regionTree: RegionTree | null = null;
let treeSrc: number[][] | undefined;           // identity guard: rebuild only when the map changes
let mode: "flat" | "tree" = "flat";
let grainLevel = 0;
export let paletteVer = 0;
export const palette = (name: string = activeTheme): RGB[] => {
  if (!name) return PALX;
  if (mode === "tree" && regionTree) return treeThemePalette(name, regionTree, grainLevel)?.colors ?? PALX;
  return themePalette(name, undefined, paletteK)?.colors ?? PALX;
};
export function setActiveTheme(name: string): number {
  if (name === activeTheme) return paletteVer;
  activeTheme = name;
  palette(name);   // generate + log the canary metrics now, while the DOM carries this theme
  return ++paletteVer;
}
export function setPaletteK(k: number): number {
  const kk = Math.max(2, Math.floor(k) || 2);
  if (kk === paletteK && mode === "flat") return paletteVer;
  paletteK = kk; mode = "flat";
  if (activeTheme) themePalette(activeTheme, undefined, kk);
  return ++paletteVer;
}
/** Hand the current map's grain ladder to the colour engine (undefined = no ladder / map closed). */
export function setRegionTree(levels?: number[][]): number {
  if (levels === treeSrc) return paletteVer;
  treeSrc = levels;
  regionTree = levels ? buildRegionTree(levels) : null;
  if (regionTree?.violations) console.warn(`[eido] grain ladder is not nested (${regionTree.violations} nodes) — tree hues may mislead`);
  return ++paletteVer;
}
/** Colour channel = region at `level`: tree hues when the map has a ladder, else spread-k over `fallbackK`. */
export function setColorRegion(level: number, fallbackK: number): number {
  if (!regionTree) return setPaletteK(fallbackK);
  if (mode === "tree" && grainLevel === level) return paletteVer;
  mode = "tree"; grainLevel = level;
  if (activeTheme) treeThemePalette(activeTheme, regionTree, level);
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
