import type { MapContract } from "../../src/schema";
import { col, axisColor, type RGB } from "./encode";

// THE DIMENSION REGISTRY — one abstraction for "a per-card value", from three sources (discovered PCA axes,
// metadata, semantic queries), replacing the three parallel registries (data.axes/scores, facets, metaVals).
// A dimension is an OBJECT WITH USER-CONTROLLABLE PROPERTIES (normalization honest⇄rank, direction). Any
// channel (position x/y/z, colour, size, scrubber) is a slot that accepts a compatible dimension and applies
// its properties uniformly — so the same little toggle works identically wherever a dimension is placed.

export type DimKind = "scalar" | "categorical" | "temporal";
export type DimSource = "region" | "axis" | "meta" | "query";
export type DimProps = { norm: "honest" | "rank"; invert: boolean };  // user-controllable, per dimension

export type Dimension = {
  key: string;
  name: string;
  kind: DimKind;
  source: DimSource;
  // scalar / temporal:
  raw?: (number | undefined)[]; // per-card raw values
  bipolar?: boolean;            // discovered axes: value grows from the centre (size); metrics/queries ramp low→high
  fixedNorm?: boolean;          // discovered axes only carry the pre-rank-normed score, so honest isn't recoverable yet
  // categorical:
  cat?: (i: number) => string | undefined;
  ord?: string[];               // categories, most-frequent first
  idx?: Record<string, number>; // category → colour index
  cnt?: Record<string, number>;
};

export const defaultProps = (d: Dimension): DimProps => ({
  norm: d.source === "axis" ? "rank" : "honest", // axes are stored rank-normed; metrics/queries default to the honest skew
  invert: false,
});

const folderOf = (u?: string) => { if (!u || !u.startsWith("file://")) return undefined; const p = u.slice(7).split("/").filter(Boolean); return p.length >= 2 ? decodeURIComponent(p[p.length - 2]).replace(/_/g, " ") : undefined; };

// categorical dimensions the corpus actually supports, self-filtered to a legible, well-covered set.
function categoricals(D: MapContract): Dimension[] {
  const n = D.ids.length;
  const defs: { key: string; name: string; get: (i: number) => string | undefined }[] = [
    { key: "folder", name: "folder", get: (i) => folderOf(D.urls?.[i]) },
    { key: "author", name: "source", get: (i) => (D.authors?.[i] ?? undefined) as string | undefined },
    { key: "site", name: "source site", get: (i) => (D.siteNames?.[i] ?? undefined) as string | undefined },
    { key: "tags", name: "tag", get: (i) => { const t = D.tags?.[i] as any; return Array.isArray(t) ? t[0] : (t ?? undefined); } },
  ];
  return defs.map((d) => {
    const cnt: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const v = d.get(i); if (v) cnt[v] = (cnt[v] || 0) + 1; }
    const ord = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
    const idx: Record<string, number> = {}; ord.forEach((v, i) => (idx[v] = i));
    return { key: d.key, name: d.name, kind: "categorical" as const, source: "meta" as const, cat: d.get, ord, idx, cnt };
  }).filter((f) => f.ord!.length >= 2 && f.ord!.length <= 40 && f.ord!.reduce((a, v) => a + f.cnt![v], 0) >= n * 0.4);
}

// Build the static dimension registry from the loaded map. `region` (the grain-driven cluster) is a categorical
// dimension built by the caller (it depends on the current grain assignment). Query dimensions are appended by
// the caller too (they're created at runtime).
export function buildDimensions(D: MapContract): Dimension[] {
  const dims: Dimension[] = [];
  // only the DISCOVERED axes — skip the injected metadata/query pseudo-axes (flagged `monotonic`) the old path
  // still pushes into D.axes during migration; this module owns metadata + queries itself.
  for (const a of D.axes) if (!(a as any).monotonic) dims.push({ key: a.key, name: a.name, kind: "scalar", source: "axis", raw: D.scores[a.key], bipolar: true, fixedNorm: true });
  dims.push({ key: "hub", name: "influence", kind: "scalar", source: "meta", raw: D.hub, bipolar: false });
  if (D.citec?.some((x) => typeof x === "number")) dims.push({ key: "citec", name: "citation impact", kind: "scalar", source: "meta", raw: D.citec as number[], bipolar: false });
  dims.push({ key: "length", name: "length", kind: "scalar", source: "meta", raw: D.cores.map((c) => (c || "").length), bipolar: false });
  if (D.dates?.some((d) => typeof d === "number")) dims.push({ key: "date", name: "date", kind: "temporal", source: "meta", raw: D.dates as number[], bipolar: false });
  dims.push(...categoricals(D));
  return dims;
}

// ---- scalar scoring: raw values → 0..100, applying the dimension's user properties (norm + invert) ----
const minMax100 = (raw: (number | undefined)[]): number[] => {
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) if (typeof v === "number") { if (v < lo) lo = v; if (v > hi) hi = v; }
  const r = hi - lo || 1;
  return raw.map((v) => (typeof v === "number" ? ((v - lo) / r) * 100 : 50));
};
const rank100 = (raw: (number | undefined)[]): number[] => {
  const n = raw.length;
  const present = raw.map((v, i) => [typeof v === "number" ? (v as number) : NaN, i] as [number, number]).filter((x) => !Number.isNaN(x[0]));
  present.sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(n).fill(50);
  const m = present.length;
  present.forEach(([, i], r) => { out[i] = m > 1 ? (100 * r) / (m - 1) : 50; });
  return out;
};

const cache = new WeakMap<Dimension, Record<string, number[]>>();
// 0..100 per card for a scalar/temporal dimension under the given props. Memoised per (dim, norm+invert).
export function scores01(dim: Dimension, props: DimProps): number[] {
  if (!dim.raw) return [];
  const tag = props.norm + (props.invert ? "!" : "");
  let byTag = cache.get(dim); if (!byTag) cache.set(dim, (byTag = {}));
  if (byTag[tag]) return byTag[tag];
  let s = props.norm === "rank" ? rank100(dim.raw) : minMax100(dim.raw);
  if (props.invert) s = s.map((v) => 100 - v);
  return (byTag[tag] = s);
}

// ---- channel accessors: a dimension + its props → a per-card colour / size / position value ----
const DIM = [58, 58, 58] as RGB; // missing categorical value
export function colorAccessor(dim: Dimension | undefined, props: DimProps, regionAssign?: number[]): (i: number) => RGB {
  if (!dim) { const a = regionAssign ?? []; return (i) => col(a[i] ?? 0); } // fallback = region
  if (dim.kind === "categorical") {
    if (dim.source === "region" && regionAssign) return (i) => col(regionAssign[i] ?? 0);
    return (i) => { const v = dim.cat!(i); return v == null ? DIM : col(dim.idx![v] ?? 0); };
  }
  const s = scores01(dim, props);
  return (i) => axisColor((s[i] ?? 50) / 100);
}
export function sizeAccessor(dim: Dimension | undefined, props: DimProps): (i: number) => number {
  if (!dim || dim.kind !== "scalar") return () => 2.6; // uniform (categorical/none can't size)
  const s = scores01(dim, props);
  return dim.bipolar
    ? (i) => 1.5 + (3 * Math.abs((s[i] ?? 50) - 50)) / 50 // bipolar: grows from the centre (both poles strong)
    : (i) => 1.5 + 3.4 * ((s[i] ?? 0) / 100);             // monotonic: big = more
}
