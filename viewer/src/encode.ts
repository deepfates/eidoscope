import type { MapContract } from "../../src/schema";

// Encodings: how a card's region/metadata/axis-position becomes colour and size. Kept out of the render
// core so the control panel + legend and the deck layers share ONE source of truth for what a colour means.

// colourblind-safe categorical palette (matches the old viewer); cycles past its length — identity is
// carried by position + labels + isolate, not colour alone.
export const PAL: [number, number, number][] = [
  [57, 135, 229], [217, 89, 38], [25, 158, 112], [201, 133, 0],
  [213, 81, 129], [0, 131, 0], [144, 133, 233], [230, 103, 103],
];
export const col = (c: number): [number, number, number] => PAL[((c % PAL.length) + PAL.length) % PAL.length];

export type RGB = [number, number, number];
function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
// continuous axis gradient (low → high): the old viewer's hsl(250→0, 74%, 40→62%).
export const axisColor = (t: number): RGB => hsl(250 - Math.max(0, Math.min(1, t)) * 250, 0.74, 0.4 + Math.max(0, Math.min(1, t)) * 0.22);

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

// colour accessor for a mode: "cluster" | "meta:<facet>" | "<axisKey>"
export function colorFor(D: MapContract, mode: string, fac: Facet[]): (i: number) => RGB {
  if (mode === "cluster") return (i) => col(D.cluster[i]);
  const f = fac.find((x) => "meta:" + x.key === mode);
  if (f) return (i) => { const v = f.get(i); return v == null ? [58, 58, 58] : col(f.idx[v]); };
  return (i) => axisColor((D.scores[mode]?.[i] ?? 50) / 100);
}

// radius accessor for a mode: "uniform" | "hub" | "<axisKey>"
export function sizeFor(D: MapContract, mode: string): (i: number) => number {
  const maxHub = Math.max(1, ...D.hub);
  if (mode === "uniform") return () => 2.6;
  if (mode === "hub") return (i) => 1.5 + 3.4 * Math.sqrt((D.hub[i] || 0) / maxHub);
  return (i) => 1.5 + (3 * Math.abs((D.scores[mode]?.[i] ?? 50) - 50)) / 50;
}
