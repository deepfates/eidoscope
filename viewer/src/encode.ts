import type { MapContract } from "../../src/schema";
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

// A metadata facet — the corpus's OWN organization (source folder, author) surfaced as a colour lens.
// Self-filtering: only offered if it covers most of the corpus and has a legible number of values.
export type Facet = { key: string; label: string; get: (i: number) => string | undefined; ord: string[]; idx: Record<string, number>; cnt: Record<string, number> };
const folderOf = (u?: string) => { if (!u || !u.startsWith("file://")) return undefined; const p = u.slice(7).split("/").filter(Boolean); return p.length >= 2 ? decodeURIComponent(p[p.length - 2]).replace(/_/g, " ") : undefined; };

export function facets(D: MapContract): Facet[] {
  const n = D.ids.length;
  const defs = [
    { key: "folder", label: "folder", get: (i: number) => folderOf(D.urls?.[i]) },
    { key: "author", label: "source", get: (i: number) => D.authors?.[i] ?? undefined },
  ];
  return defs.map((d) => {
    const cnt: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const v = d.get(i); if (v) cnt[v] = (cnt[v] || 0) + 1; }
    const ord = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
    const idx: Record<string, number> = {}; ord.forEach((v, i) => (idx[v] = i));
    return { ...d, cnt, ord, idx };
  }).filter((f) => f.ord.length >= 2 && f.ord.length <= 40 && f.ord.reduce((a, v) => a + f.cnt[v], 0) >= n * 0.4);
}

// colour accessor for a mode: "cluster" | "meta:<facet>" | "<axisKey>". `assign` = the per-node region
// at the CURRENT grain (defaults to D.cluster) so colour follows the grain slider, not just the default level.
export function colorFor(D: MapContract, mode: string, fac: Facet[], assign?: number[]): (i: number) => RGB {
  if (mode === "cluster") { const a = assign ?? D.cluster; return (i) => col(a[i]); }
  const f = fac.find((x) => "meta:" + x.key === mode);
  if (f) return (i) => { const v = f.get(i); return v == null ? [58, 58, 58] : col(f.idx[v]); };
  return (i) => axisColor((D.scores[mode]?.[i] ?? 50) / 100);
}

// radius accessor for a mode: "uniform" | "hub" | "<axisKey>". Discovered axes are BIPOLAR (both poles are
// "strong"), so size grows from the centre |score-50|. A dimension flagged `monotonic` (a metric like length,
// or a semantic-query similarity) ramps low→high instead — big = more, small = less.
export function sizeFor(D: MapContract, mode: string): (i: number) => number {
  const maxHub = Math.max(1, ...D.hub);
  if (mode === "uniform") return () => 2.6;
  if (mode === "hub") return (i) => 1.5 + 3.4 * Math.sqrt((D.hub[i] || 0) / maxHub);
  const mono = (D.axes.find((a) => a.key === mode) as any)?.monotonic;
  if (mono) return (i) => 1.5 + 3.4 * ((D.scores[mode]?.[i] ?? 0) / 100);
  return (i) => 1.5 + (3 * Math.abs((D.scores[mode]?.[i] ?? 50) - 50)) / 50;
}
