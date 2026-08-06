import { schemeTableau10, interpolateSinebow, interpolateViridis } from "d3-scale-chromatic";
import { rgb } from "d3-color";

// Encodings: how a card's region/metadata/axis-position becomes colour and size. Kept out of the render
// core so the control panel + legend and the deck layers share ONE source of truth for what a colour means.

export type RGB = [number, number, number];
// Categorical palette from the ecosystem instead of a hand-rolled one: Tableau 10 (the widely-used,
// colourblind-conscious default) colours the common small-category case; for high-cardinality sets
// (21 regions, 34 folders) we extend by sampling Sinebow — d3's evenly-spaced cyclic hue interpolator —
// so the long tail stays DISTINGUISHABLE before cycling. Identity is also carried by position + isolate.
const toRGB = (s: string): RGB => { const c = rgb(s); return [Math.round(c.r), Math.round(c.g), Math.round(c.b)]; };
export const PAL: RGB[] = schemeTableau10.map(toRGB);
export const PALX: RGB[] = (() => {
  const out: RGB[] = PAL.map((c) => [...c] as RGB);
  const tail = 24 - out.length;
  for (let i = 0; i < tail; i++) out.push(toRGB(interpolateSinebow((i + 0.5) / tail)));
  return out;
})();
export const col = (c: number): RGB => PALX[((c % PALX.length) + PALX.length) % PALX.length];
// continuous axis gradient (low → high) = Viridis, the ecosystem-standard perceptually-uniform,
// colourblind-friendly sequential scale (replaces a hand-rolled blue→red HSL ramp that wasn't uniform).
export const axisColor = (t: number): RGB => toRGB(interpolateViridis(Math.max(0, Math.min(1, t))));
