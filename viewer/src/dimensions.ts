import type { MapContract, MetaField } from "../../src/schema";
import { col, scalarRamp, type RGB } from "./encode";

// THE DIMENSION REGISTRY — one abstraction for "a per-card value", from three sources (discovered PCA axes,
// metadata, semantic queries), replacing the three parallel registries (data.axes/scores, facets, metaVals).
// A dimension is an OBJECT WITH USER-CONTROLLABLE PROPERTIES (normalization honest⇄rank, direction). Any
// channel (position x/y/z, colour, size, scrubber) is a slot that accepts a compatible dimension and applies
// its properties uniformly — so the same little toggle works identically wherever a dimension is placed.

export type DimKind = "scalar" | "categorical" | "temporal";
export type DimSource = "axis" | "meta" | "query" | "derived";
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
  low?: string;                 // gradient legend poles (discovered axes; query low = "unrelated")
  high?: string;
  variance?: number;            // discovered axes: PCA variance share (legend strength)
  weak?: boolean;
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

// ---- the META-FIELD MANIFEST (`D.metaFields`) → dimensions ----------------------------------------------
// The pipeline DECLARES each corpus field and its type (src/map.ts buildMetaFields); the viewer only has to
// resolve `source` to values. Display names come STRAIGHT FROM THE MANIFEST — the file's own declaration is
// the single source of a dimension's name (the naming rulings live in the pipeline's buildMetaFields).
const nameOf = (f: MetaField) => f.label;

// Resolve one MetaField.source to a per-card accessor. `col:<field>` reads the named parallel column;
// `derived:<k>` is something the viewer computes (folder from urls, length from cores).
function resolve(D: MapContract, f: MetaField): ((i: number) => unknown) | null {
  // Two DISJOINT column namespaces (eid-xmf0), no fallthrough between them: `mcol:<key>` reads ONLY the
  // generic store (D.cols), `col:<field>` reads ONLY the named hand-declared top-level property. An
  // incoming generic column named `authors` therefore coexists with the native authors dimension —
  // each source resolves its own data, neither can shadow the other.
  if (f.source.startsWith("mcol:")) {
    const gc = D.cols?.find((c) => c.key === f.source.slice(5));
    return gc ? (i) => gc.values[i] : null;
  }
  if (f.source.startsWith("col:")) {
    const arr = (D as unknown as Record<string, unknown[]>)[f.source.slice(4)];
    if (!Array.isArray(arr)) return null;
    return (i) => arr[i];
  }
  if (f.source === "derived:folder") return (i) => folderOf(D.urls?.[i]);
  if (f.source === "derived:length") return (i) => (D.cores[i] || "").length;
  return null;   // axis:* is served from D.axes; anything else is a field this viewer doesn't know how to read
}

// A declared field → a Dimension (or null when the corpus doesn't actually carry usable values for it).
function dimOf(D: MapContract, f: MetaField): Dimension | null {
  const get = resolve(D, f); if (!get) return null;
  const n = D.ids.length;
  if (f.type === "scalar" || f.type === "temporal") {
    const raw = Array.from({ length: n }, (_, i) => { const v = get(i); return typeof v === "number" ? v : undefined; });
    if (!raw.some((v) => typeof v === "number")) return null;
    return { key: f.key, name: nameOf(f), kind: f.type, source: "meta", raw, bipolar: false };
  }
  // categorical + boolean both become a categorical dimension. A multi-valued field (tags) is represented by
  // its FIRST value — one card sits in one colour bucket.
  const cat = f.type === "boolean"
    ? (i: number) => { const v = get(i); return v === true ? nameOf(f) : v === false ? "not " + nameOf(f) : undefined; }
    : (i: number) => { const v = get(i); const s = f.multi && Array.isArray(v) ? v[0] : v; return typeof s === "string" && s ? s : undefined; };
  const cnt: Record<string, number> = {};
  for (let i = 0; i < n; i++) { const v = cat(i); if (v) cnt[v] = (cnt[v] || 0) + 1; }
  const ord = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
  // self-filter to a legible, well-covered set: at least two values, not a near-unique id column, and present
  // on a real share of the corpus. A field that fails this would make a useless colour lens.
  if (ord.length < 2 || ord.length > 40 || ord.reduce((a, v) => a + cnt[v], 0) < n * 0.4) return null;
  const idx: Record<string, number> = {}; ord.forEach((v, i) => (idx[v] = i));
  return { key: f.key, name: nameOf(f), kind: "categorical", source: "meta", cat, ord, idx, cnt };
}

// A file without a manifest gets ONLY what the viewer can derive itself (folder from urls, length from
// cores) — honestly, with no guessed column set. Every emitted .eido declares its fields.
const DERIVED_ONLY: MetaField[] = [
  { key: "length", label: "length", type: "scalar", source: "derived:length" },
  { key: "folder", label: "folder", type: "categorical", source: "derived:folder" },
];

// Build the static dimension registry from the loaded map. The region clustering is NOT a dimension: it's the
// `color: "region"` sentinel (see model.svelte.ts) because it's grain-derived, not a stored per-card column.
// Query dimensions are appended by the caller (they're created at runtime).
export function buildDimensions(D: MapContract): Dimension[] {
  const dims: Dimension[] = [];
  // only the DISCOVERED axes — skip the injected metadata/query pseudo-axes (flagged `monotonic`) the old path
  // still pushes into D.axes during migration; this module owns metadata + queries itself.
  // Prefer the RAW PCA projection when the file carries it: then honest (true magnitude) AND rank (even spread)
  // are both real, so the norm toggle works on axes. Older files carry only the rank-normed scores → fixedNorm
  // (rank is the only recoverable view). Default props keep axes on rank either way (readable geometry).
  for (const a of D.axes) if (!(a as any).monotonic) { const raw = D.rawScores?.[a.key]; dims.push({ key: a.key, name: a.name, kind: "scalar", source: "axis", raw: raw ?? D.scores[a.key], bipolar: true, fixedNorm: !raw, low: (a as any).low, high: (a as any).high, variance: (a as any).variance, weak: (a as any).weak }); }
  // metadata dimensions come from the file's own typed manifest when it has one (v2), else the legacy set.
  // `axis:*` entries are skipped — the discovered axes are already served above, straight from D.axes.
  const fields = (D.metaFields?.length ? D.metaFields : DERIVED_ONLY).filter((f) => !f.source.startsWith("axis:"));
  const meta = fields.map((f) => dimOf(D, f)).filter((d): d is Dimension => !!d);
  // scalars/temporals first, categoricals after — the order the channel menus have always presented.
  dims.push(...meta.filter((d) => d.kind !== "categorical"), ...meta.filter((d) => d.kind === "categorical"));
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
// A scalar/temporal dimension's ramp under its props: theme-derived OKLCH (encode.scalarRamp) —
// monotone lightness for monotonic dims, diverging (pole hues = the axis's own members' colour
// centres) for bipolar discovered axes. Shared by the deck accessor and the legend swatches.
export function rampFor(dim: Dimension, props: DimProps): (t: number) => RGB {
  return scalarRamp(dim.raw ? scores01(dim, props) : undefined, !!dim.bipolar);
}
export function colorAccessor(dim: Dimension | undefined, props: DimProps, regionAssign?: number[]): (i: number) => RGB {
  if (!dim) { const a = regionAssign ?? []; return (i) => col(a[i] ?? 0); } // fallback = region
  if (dim.kind === "categorical") return (i) => { const v = dim.cat!(i); return v == null ? DIM : col(dim.idx![v] ?? 0); };
  const s = scores01(dim, props), ramp = rampFor(dim, props);
  return (i) => ramp((s[i] ?? 50) / 100);
}
export function sizeAccessor(dim: Dimension | undefined, props: DimProps): (i: number) => number {
  if (!dim || dim.kind !== "scalar") return () => 2.6; // uniform (categorical/none can't size)
  const s = scores01(dim, props);
  return dim.bipolar
    ? (i) => 1.5 + (3 * Math.abs((s[i] ?? 50) - 50)) / 50 // bipolar: grows from the centre (both poles strong)
    : (i) => 1.5 + 3.4 * ((s[i] ?? 0) / 100);             // monotonic: big = more
}
