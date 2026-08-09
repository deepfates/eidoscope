// THE VIEW MODEL — the state core of the viewer, lifted out of App.svelte so the model can be read, reasoned
// about and (later) driven by something other than one 700-line component. App.svelte keeps the DOM, the deck
// handle, the camera and the browser (history/localStorage); everything here is pure view STATE + derivations.
//
// The channel grammar made explicit: a CHANNEL is a slot that holds a Dimension.key (or a sentinel). Every
// channel draws from the same registry, so "reset every channel pointing at dimension K" is ONE loop instead
// of seven hand-written ifs.

import type { MapContract, ViewState } from "../../src/schema";
import type { Layout } from "./deckmap";
import { distinctiveTerms, distinctiveAxes } from "../../src/distinct";
import { buildDimensions, sizeAccessor, colorAccessor, scores01, defaultProps, type Dimension, type DimProps } from "./dimensions";
import { encodeIdxSet, fnv1a, parseIdSet, type UrlIdSet } from "./idset";

export type ChannelName = "color" | "size" | "x" | "y" | "z" | "scrub" | "sort";
// A channel holds a Dimension.key, or one of these documented sentinels:
//   "region"  (color only) — colour by the grain clustering rather than by a dimension
//   "uniform" (size only)  — no size dimension; every card the same radius
//   ""                     — unset (the scrubber before a field is chosen; x/y/z before a map is mounted)
export type Channels = Record<ChannelName, string>;

export const CHANNELS: ChannelName[] = ["color", "size", "x", "y", "z", "scrub", "sort"];

// What a channel holds on a FRESH viewer, before any map is mounted.
const INITIAL: Channels = { color: "region", size: "hub", x: "", y: "", z: "", scrub: "", sort: "hub" };
// What a channel FALLS BACK to when the dimension it points at disappears (a query is removed). Distinct from
// INITIAL on purpose: size starts on "hub" (influence is the useful default) but releases to "uniform".
const RELEASE: Omit<Channels, "x" | "y" | "z"> = { color: "region", size: "uniform", scrub: "", sort: "hub" };

// x/y/z defaults are DATA-dependent (the first three discovered axes), so both the mount path and the release
// path ask for them here rather than each spelling out its own `?? axes[0] ?? ""` chain.
export const defaultsFor = (D: MapContract | null): Pick<Channels, "x" | "y" | "z"> => ({
  x: D?.axes[0]?.key ?? "",
  y: D?.axes[1]?.key ?? D?.axes[0]?.key ?? "",
  z: D?.axes[2]?.key ?? D?.axes[0]?.key ?? "",
});

// UNIFIED FILTER: one declarative list (facet membership · region cluster · text search). The scrubber range
// is folded into the same intersection mask below. Declarative (not predicates) so it serializes and diffs.
export type Filter =
  | { kind: "cat"; key: string; label: string; value: string }        // categorical dimension = value
  | { kind: "region"; key: "region"; label: string; cluster: number } // cluster at the current grain
  | { kind: "text"; key: "text"; label: string; q: string }           // title/body substring
  // A materialized SELECTION, converted into a filter. Extensional by construction (frozen indices), which
  // is exactly why it composes: once it is a Filter it intersects with every other filter and gets a chip,
  // with no special case anywhere downstream.
  | { kind: "set"; key: "set"; label: string; idx: number[] };

// Pinning a region/facet is TWO acts: a state mutation (this module) and a camera move (App owns the deck
// handle). The model returns the camera intent rather than reaching for a handle it shouldn't know about.
export type CameraOp = { kind: "fit"; indices: number[] } | { kind: "reset" } | null;

// Everything a restored view can carry — ONE shape for both carriers (eid-thbs). A saved view in the
// .eido is a plain ViewState (full id lists, no cap); a URL decodes to the SAME shape except that its
// sets arrive as encoded index-sets (UrlIdSet) still needing resolution against the corpus, and a
// derived dim may reference the shared selection (`ref`) instead of repeating it. The eager half is
// applied by applyPatch(); the deferred half (region/facet/find/card — they depend on grain-derived
// state — plus the query texts, which need embedding) is handed back to App, which owns the async.
export type StatePatch = Omit<ViewState, "selection" | "derived"> & {
  scrubbed?: boolean;   // a window was restored → App must remount the slider (scrubNonce)
  selection?: string[] | UrlIdSet;
  // DERIVED dimensions can't be recomputed from a label — they need their examples. From a URL each
  // arrives as `<label>~<key>:<set>` (key so channels pointing at it survive a reload; legacy
  // `<label>~<ids>` still parses, keyless); from a saved view, as full ids under its key.
  derived?: { label: string; key?: string; ids?: string[]; set?: UrlIdSet; ref?: boolean }[];
};

export function parseUrl(search: string): StatePatch {
  const p = new URLSearchParams(search);
  const out: StatePatch = {
    queries: p.getAll("q"),
    derived: p.getAll("d").flatMap((s): NonNullable<StatePatch["derived"]> => {
      const t = s.indexOf("~"); if (t < 0) return [];
      const label = s.slice(0, t); let payload = s.slice(t + 1);
      let key: string | undefined;
      const km = payload.match(/^(d\d+):/); if (km) { key = km[1]; payload = payload.slice(km[0].length); }
      if (!label || !payload) return [];
      if (payload === "s") return [{ label, key, ref: true }];   // examples = the sel= set, carried once
      const set = parseIdSet(payload);
      return set ? [{ label, key, set }] : [];
    }),
  };
  const ch: NonNullable<ViewState["channels"]> = {};
  const L = p.get("layout"); if (L === "mde" || L === "axes" || L === "orbit" || L === "axes3d") out.layout = L;
  const c = p.get("color"); if (c) ch.color = c;
  const s = p.get("size"); if (s) ch.size = s;
  const x = p.get("x"); if (x) ch.x = x;
  const y = p.get("y"); if (y) ch.y = y;
  const z = p.get("z"); if (z) ch.z = z;
  const g = p.get("grain"); if (g && !Number.isNaN(+g)) out.grain = +g;
  // per-dimension props (norm/invert): key.<h|r><0|1>, comma-joined
  const props = p.get("props");
  if (props) {
    const next: Record<string, DimProps> = {};
    for (const e of props.split(",")) {
      const dot = e.lastIndexOf("."); const k = e.slice(0, dot), code = e.slice(dot + 1);
      if (k && code.length >= 2 && (code[0] === "r" || code[0] === "h")) next[k] = { norm: code[0] === "r" ? "rank" : "honest", invert: code[1] === "1" };
    }
    out.dimProps = next;
  }
  const sk = p.get("sk"); if (sk) ch.scrub = sk;
  if (Object.keys(ch).length) out.channels = ch;
  const slo = p.get("slo"), shi = p.get("shi");
  const win: NonNullable<ViewState["window"]> = {};
  if (slo !== null && !Number.isNaN(+slo)) win.lo = +slo;
  if (shi !== null && !Number.isNaN(+shi)) win.hi = +shi;
  if (slo !== null || shi !== null) { out.window = win; out.scrubbed = true; }
  const r = p.get("region"); if (r && !Number.isNaN(+r)) out.region = +r;
  const fp = p.get("facet"); if (fp) out.facet = fp;
  const find = p.get("find"); if (find) out.find = find;
  const card = p.get("card"); if (card) out.card = card;
  const sel = p.get("sel"); if (sel) { const set = parseIdSet(sel); if (set) out.selection = set; }
  return out;
}

export class ViewModel {
  data = $state<MapContract | null>(null);
  layout = $state<Layout>("mde");
  channels = $state<Channels>({ ...INITIAL });
  grain = $state(0);
  selected = $state<number | null>(null);
  pinned = $state<number | null>(null);            // isolated region (kept for legend styling / hover)
  // dimProps holds per-dimension user overrides (norm/invert), keyed by dim.key so the props travel WITH the
  // dimension — toggling honest⇄rank changes it identically wherever it's placed (colour/size/x/y/z).
  dimProps = $state<Record<string, DimProps>>({});
  filters = $state<Filter[]>([]);
  // N semantic queries, each a first-class dimension: {key, text, raw cosines}. Once added, a query shows up in
  // every channel menu like any other dimension. Filtering by a query = putting it on the scrubber.
  queries = $state<{ key: string; text: string; raw: number[] }[]>([]);
  // DERIVED dimensions (eid-8139): the same object a query produces, but the direction came from EXAMPLES.
  // `ids` are the example cards' ids (not indices) so the dimension can be re-derived from a shared URL.
  derived = $state<{ key: string; label: string; ids: string[]; raw: number[] }[]>([]);
  query = $state("");                              // the find-box substring (mirrored into a "text" filter)
  scrubLo = $state<number | null>(null);           // window lower bound; null = field min
  scrubHi = $state<number | null>(null);           // window upper bound; null = field max (both null = show all)
  // ── SELECT (eid-r8t6) ──────────────────────────────────────────────────────────────────────────────
  // A selection is EXTENSIONAL: the frozen set of card indices a gesture resolved to, materialized at
  // gesture end. Not a re-evaluable predicate — a lasso in 3D depends on the camera, so the RESULT is
  // portable and the gesture is not. The model owns it; deckmap only renders it.
  selection = $state<number[] | null>(null);
  selectMode = $state(false);                      // the lasso owns the pointer while this is on
  private qN = 0;                                  // monotonic id source for stable query keys
  private dN = 0;                                  // …and for derived-dimension keys

  // App owns the slider-remount nonce (a view hack), so a model-side scrub reset tells it to re-read.
  onScrubReset: (() => void) | undefined;

  // ---- the dimension registry: one list all channels draw from ----
  dimList = $derived(this.data ? buildDimensions(this.data) : []);
  queryDims = $derived.by((): Dimension[] =>
    this.queries.map((q) => ({ key: q.key, name: "? " + q.text, kind: "scalar", source: "query", raw: q.raw, bipolar: false, low: "unrelated", high: q.text })));
  derivedDims = $derived.by((): Dimension[] =>
    this.derived.map((d) => ({ key: d.key, name: "≈ " + d.label, kind: "scalar", source: "derived", raw: d.raw, bipolar: false, low: "unlike", high: d.label })));
  // ONE registry. A derived dimension is not special-cased anywhere downstream: every channel menu, the
  // scrubber, the deck sort, honest⇄rank + invert and the ✕ all read this list.
  mintedDims = $derived([...this.queryDims, ...this.derivedDims]);
  allDims = $derived([...this.dimList, ...this.mintedDims]);

  colorDim = $derived(this.channels.color === "region" ? undefined : this.allDims.find((d) => d.key === this.channels.color)); // undefined = the region clustering
  xDim = $derived(this.allDims.find((d) => d.key === this.channels.x));
  yDim = $derived(this.allDims.find((d) => d.key === this.channels.y));
  zDim = $derived(this.allDims.find((d) => d.key === this.channels.z));
  sizeDim = $derived(this.channels.size === "uniform" ? undefined : this.allDims.find((d) => d.key === this.channels.size));

  propsOf = (d: Dimension): DimProps => this.dimProps[d.key] ?? defaultProps(d);
  // One writer for per-dimension props.
  setProp(d: Dimension, patch: Partial<DimProps>) { this.dimProps = { ...this.dimProps, [d.key]: { ...this.propsOf(d), ...patch } }; }
  // The two poles of a scalar dim as [score-0 label, score-100 label]. scores01 applies invert, so when a dim is
  // inverted the labels swap too — keeping the legend/axis honest (the pole where a card sits matches its label).
  poles = (d: Dimension): [string, string] => { const lo = d.low ?? "low " + d.name, hi = d.high ?? d.name; return this.propsOf(d).invert ? [hi, lo] : [lo, hi]; };

  // ---- channel accessors (dims passed in so mountMap can use a registry built before `data` is reactive) ----
  sizeGet = (dims: Dimension[], key: string) => { const d = dims.find((x) => x.key === key); return sizeAccessor(d, d ? this.propsOf(d) : { norm: "honest", invert: false }); };
  colorGet = (dims: Dimension[], key: string, assign: number[]) => { const d = dims.find((x) => x.key === key); return colorAccessor(d, d ? this.propsOf(d) : { norm: "honest", invert: false }, assign); };
  // position accessor: a chosen scalar dimension → per-card coord in -1..1 (its norm/invert applied). Axis-scatter only.
  posGet = (dims: Dimension[], key: string) => { const d = dims.find((x) => x.key === key); if (!d || d.kind === "categorical") return () => 0; const s = scores01(d, this.propsOf(d)); return (i: number) => ((s[i] ?? 50) - 50) / 50; };

  // Position accessors are fresh closures each update but deckmap only recomputes positions on a KEY change —
  // so a prop-only change (same x, new norm) wouldn't move the points. This signature makes the change
  // observable: deckmap bumps posVer whenever posSig differs. It MUST stay a plain $derived — a self-
  // incrementing $effect hung the app before (never write state another $derived/$effect reads in one flush).
  posSig = $derived.by(() => {
    const sig = (k: string) => { const d = this.allDims.find((x) => x.key === k); return d ? [k, this.propsOf(d).norm, this.propsOf(d).invert] : [k]; };
    return JSON.stringify([sig(this.channels.x), sig(this.channels.y), sig(this.channels.z)]);
  });

  // ---- the region clustering at the current grain ----
  nLevels = $derived(this.data?.counts?.length ?? 1);
  assignment = $derived(this.data?.levels?.[this.grain] ?? this.data?.cluster ?? []);
  curCount = $derived(this.data?.counts?.[this.grain] ?? this.data?.k ?? 0);
  curClusters = $derived.by(() => {
    const D = this.data; if (!D) return [] as { c: number; label: string; n: number }[];
    const a = this.assignment, k = this.curCount, labels = D.levelLabels?.[this.grain];
    const cnt = new Array(k).fill(0); for (const c of a) if (c >= 0 && c < k) cnt[c]++;
    return Array.from({ length: k }, (_, c) => ({ c, label: labels?.[c] ?? D.clusters[c]?.label ?? "region " + c, n: cnt[c] }));
  });
  membersOf = (c: number) => { const out: number[] = []; this.assignment.forEach((v, i) => { if (v === c) out.push(i); }); return out; };
  facetMembers = (v: string) => { const out: number[] = []; const d = this.colorDim; if (!d?.cat || !this.data) return out; for (let i = 0; i < this.data.ids.length; i++) if (d.cat(i) === v) out.push(i); return out; };

  // ---- filters ----
  // Region isolate = a hard filter on the cluster at the current grain.
  togglePin(c: number): CameraOp {
    const i = this.filters.findIndex((f) => f.kind === "region" && f.cluster === c);
    if (i >= 0) { this.filters = this.filters.filter((_, j) => j !== i); this.pinned = null; return { kind: "reset" }; }
    this.filters = [...this.filters.filter((f) => f.kind !== "region"), { kind: "region", key: "region", label: this.curClusters.find((x) => x.c === c)?.label ?? "region " + c, cluster: c }];
    this.pinned = c;
    return { kind: "fit", indices: this.membersOf(c) };
  }
  // Facet isolate = a hard filter on the colour dimension's value.
  toggleFacetPin(v: string): CameraOp {
    const key = this.colorDim?.key; if (!key) return null;
    const i = this.filters.findIndex((f) => f.kind === "cat" && f.key === key && f.value === v);
    if (i >= 0) { this.filters = this.filters.filter((_, j) => j !== i); return { kind: "reset" }; }
    this.filters = [...this.filters.filter((f) => !(f.kind === "cat" && f.key === key)), { kind: "cat", key, label: v, value: v }];
    return { kind: "fit", indices: this.facetMembers(v) };
  }
  removeFilter(f: Filter) { this.filters = this.filters.filter((x) => x !== f); if (f.kind === "region") this.pinned = null; if (f.kind === "text") this.query = ""; }
  // "clear all filters" clears FILTERS. A held selection is not a filter (it has no chip, and it only
  // becomes one via filterToSelection) — destroying it here silently ate a lasso the user had just drawn.
  clearFilters() { this.filters = []; this.pinned = null; this.query = ""; this.resetScrub(); }
  // Changing the grain re-cuts the regions, so a region filter naming cluster #N no longer means what the
  // user chose — the filter must go WITH the pointer. Doing half of it (nulling `pinned` only, as the
  // slider used to) left an invisible mask on a re-numbered cluster and dropped ?region= from the URL.
  setGrain(g: number) {
    if (g === this.grain) return;
    this.grain = g;
    this.pinned = null;
    this.filters = this.filters.filter((f) => f.kind !== "region");
  }

  // ── the SELECTION verbs ────────────────────────────────────────────────────────────────────────────
  setSelection(idx: number[]) { this.selection = idx.length ? [...idx].sort((a, b) => a - b) : null; }
  clearSelection() { this.selection = null; }
  toggleSelectMode(on?: boolean) { this.selectMode = on ?? !this.selectMode; }
  selectionSet = $derived(this.selection ? new Set(this.selection) : null);
  // FILTER TO THESE: the selection stops being an emphasis and becomes a hard mask, as one more Filter.
  // Composing with the rest is then free — the chips row, the intersection mask and clear-all all already
  // know how to handle a Filter.
  filterToSelection() {
    const sel = this.selection; if (!sel?.length) return;
    this.filters = [...this.filters.filter((f) => f.kind !== "set"), { kind: "set", key: "set", label: "selection (" + sel.length + ")", idx: [...sel] }];
    this.clearSelection();
  }
  // EXPORT: the curation loop's first sink — a plain JSON of what you circled.
  selectionExport(): { ids: string[]; titles: string[]; urls: (string | undefined)[] } | null {
    const D = this.data, sel = this.selection; if (!D || !sel?.length) return null;
    return { ids: sel.map((i) => D.ids[i]), titles: sel.map((i) => D.titles[i]), urls: sel.map((i) => D.urls?.[i]) };
  }
  // THE EXPLAIN STEP — a circled clump has to say what it IS, in the corpus's own variables. Same two
  // functions the pipeline uses to name a region (src/distinct.ts), pointed at the held set instead.
  selectionTerms = $derived.by((): string[] => {
    const D = this.data, sel = this.selection;
    if (!D || !sel?.length) return [];
    return distinctiveTerms(D.cores, [sel], { top: 8, minDocs: 2 })[0] ?? [];
  });
  selectionAxes = $derived.by((): { name: string; pole: string; mean: number }[] => {
    const D = this.data, sel = this.selection;
    if (!D || !sel?.length) return [];
    return distinctiveAxes(D.scores, D.axes, sel, 4);
  });
  // An id set rides in the URL as delta-encoded sorted indices + checksum (idset.ts) — measured at
  // 1.34–1.9 chars/card for corpora of 500–20,000 cards (vs ~27/card spelling ULIDs out). The cap is on the
  // ENCODED length, and it comes from the URL itself: the lowest widely-enforced URL limit in the wild is
  // 2,083 chars (IE's, still the floor many share sinks assume); the rest of a busy view's params measured
  // ~280 chars, leaving ~1,800 for the set — ≈1,300 cards at the measured density. Past that we serialize
  // NOTHING and say so, rather than silently truncating (a truncated set would be a LIE about what was shared).
  static SET_PARAM_CAP = 1800;
  // encode a set of indices for THIS corpus (checksummed against the ids they name), or null with no corpus
  private encSet(idx: number[]): string | null {
    const D = this.data; if (!D) return null;
    return "*" + encodeIdxSet(idx, fnv1a([...new Set(idx)].sort((a, b) => a - b).map((i) => D.ids[i]).join(",")));
  }
  selEnc = $derived.by((): string | null => (this.selection?.length && this.data ? this.encSet(this.selection) : null));
  selShareable = $derived(!this.selection?.length || (this.selEnc !== null && this.selEnc.length <= ViewModel.SET_PARAM_CAP));
  // A derived dim's payload: `s` when its examples ARE the shareable current selection (carried once, in
  // sel=), else its own encoded set — or null past the cap (the axis won't survive the link; the pane says so).
  private derivedPayload(d: { ids: string[] }): string | null {
    const D = this.data; if (!D) return null;
    const sel = this.selection;
    if (sel?.length === d.ids.length && this.selShareable && this.selEnc) {
      const s = new Set(d.ids);
      if (sel.every((i) => s.has(D.ids[i]))) return "s";
    }
    const idToIdx = new Map(D.ids.map((id, i) => [id, i]));
    const idx = d.ids.map((id) => idToIdx.get(id)).filter((i): i is number => i !== undefined);
    if (!idx.length) return null;
    const enc = this.encSet(idx);
    return enc && enc.length <= ViewModel.SET_PARAM_CAP ? enc : null;
  }
  // …the same honesty for a derived dimension: if its examples don't ride in the link, the dimension won't
  // come back on reload — say it rather than let a shared view quietly lose an axis.
  derivedShareable = (key: string): boolean => { const d = this.derived.find((x) => x.key === key); return !!d && this.derivedPayload(d) !== null; };
  // The isolated facet VALUE is derived, never stored: it is simply "is there a categorical filter on the
  // dimension colour currently shows". Switching the colour lens therefore cannot delete a filter (it used
  // to — an effect wrote state and ate "author = Alice" when you coloured by folder); the filter lives on
  // its DIMENSION, keeps filtering, keeps its chip, and lights its legend row again when you come back.
  facetPin = $derived.by((): string | null => {
    const key = this.colorDim?.key; if (!key) return null;
    const f = this.filters.find((x) => x.kind === "cat" && x.key === key) as Extract<Filter, { kind: "cat" }> | undefined;
    return f?.value ?? null;
  });
  // text search = a filter (hard hide), synced from the find box — no separate deck path.
  onFind(v: string) {
    this.query = v; const q = v.trim();
    const others = this.filters.filter((f) => f.kind !== "text");
    this.filters = q ? [...others, { kind: "text", key: "text", label: "“" + q + "”", q }] : others;
  }
  // Build a per-filter test from the declarative record (categorical membership / region cluster / substring).
  filterTest = (f: Filter): ((i: number) => boolean) => {
    const D = this.data; if (!D) return () => true;
    if (f.kind === "text") { const s = f.q.toLowerCase(), T = D.titles, C = D.cores; return (i) => T[i].toLowerCase().includes(s) || C[i].toLowerCase().includes(s); }
    if (f.kind === "region") { const a = this.assignment; return (i) => a[i] === f.cluster; }
    if (f.kind === "set") { const s = new Set(f.idx); return (i) => s.has(i); }
    const d = this.allDims.find((x) => x.key === f.key); if (!d?.cat) return () => true; return (i) => d.cat!(i) === f.value;
  };
  // THE intersection mask: 1 = passes EVERY active filter (discrete + scrubber), 0 = hidden. null = none active.
  filterMask = $derived.by((): Uint8Array | null => {
    const D = this.data; if (!D) return null;
    const tests = this.filters.map(this.filterTest); const st = this.scrubTest; if (st) tests.push(st);
    if (!tests.length) return null;
    const n = D.ids.length, m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = tests.every((t) => t(i)) ? 1 : 0;
    return m;
  });
  // Active filters as removable chips (the scrubber window is one too, so clear/remove works uniformly).
  chips = $derived.by((): { label: string; remove: () => void }[] => {
    const out = this.filters.map((f) => ({ label: f.label, remove: () => this.removeFilter(f) }));
    if (this.scrubTest && this.scrubField) out.push({ label: this.scrubField.name + " window", remove: () => this.resetScrub() });
    return out;
  });

  // ---- scrubber: ONE slider that windows ANY scalar/temporal dimension ----
  scrubFields = $derived(this.allDims.filter((d) => d.kind === "scalar" || d.kind === "temporal"));
  scrubField = $derived(this.scrubFields.find((d) => d.key === this.channels.scrub));
  scrubVals = $derived(this.scrubField?.raw ?? null);  // window on the dim's raw values (dates/counts/scores)
  scrubRange = $derived.by((): [number, number] | null => {
    const vs = this.scrubVals; if (!vs) return null;
    let lo = Infinity, hi = -Infinity;
    for (const v of vs) if (typeof v === "number") { if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi > lo ? [lo, hi] : null;
  });
  // scrubLo/scrubHi stay null = "show everything" until dragged (they READ `?? min/max`, WRITE only on input,
  // so they never write a default back on mount — the race that emptied the map on load).
  scrubTest = $derived.by((): ((i: number) => boolean) | null => {
    const r = this.scrubRange, vs = this.scrubVals, lo = this.scrubLo, hi = this.scrubHi;
    if (!r || !vs) return null;
    if (!((lo != null && lo > r[0]) || (hi != null && hi < r[1]))) return null; // wide open = no filter
    const L = lo ?? r[0], H = hi ?? r[1];
    return (i) => { const v = vs[i]; return typeof v === "number" && v >= L && v <= H; };
  });
  resetScrub() { this.scrubLo = null; this.scrubHi = null; this.onScrubReset?.(); }
  // called from an $effect in App: park the scrubber on a real field once the registry exists
  ensureScrubKey() { if (!this.channels.scrub && this.scrubFields.length) this.channels.scrub = (this.scrubFields.find((d) => d.kind === "temporal") ?? this.scrubFields[0]).key; }

  // ---- queries as dimensions ----
  addQuery(text: string, raw: number[]): string {
    const key = "q" + this.qN++;
    this.queries = [...this.queries, { key, text, raw }];
    return key;
  }
  // ---- derived dimensions (DERIVE): minted from a selection, registered exactly like a query ----
  // Minting changes EXACTLY ONE THING: a new dimension exists. It places itself on no channel, and the
  // selection it came from stays held (deriving doesn't consume it).
  // `key` is passed when restoring from a URL: the serialized channels name the dim by key (color=d1), so
  // the restored dim must come back UNDER ITS OWN KEY — renumbering positionally handed a channel to a
  // different axis whenever a sibling dim didn't survive the link (the eid-0iql label-drift bug).
  addDerived(label: string, ids: string[], raw: number[], key?: string): string {
    const k = key && /^d\d+$/.test(key) && !this.derived.some((d) => d.key === key) ? key : "d" + this.dN;
    this.dN = Math.max(this.dN, +k.slice(1) + 1);
    this.derived = [...this.derived, { key: k, label, ids, raw }];
    return k;
  }
  renameDerived(key: string, label: string) { this.derived = this.derived.map((d) => (d.key === key ? { ...d, label } : d)); }
  // remove a MINTED dimension (query or derived); every channel pointing at it falls back to its default.
  // ONE loop, not seven ifs. If it was the WINDOWED dimension, the window's numbers must die with it:
  // cosine bounds silently re-applied to whatever dimension the scrubber lands on next (dates in epoch-ms)
  // hid the whole corpus.
  removeDimension(key: string) {
    const wasWindowed = this.channels.scrub === key;
    this.queries = this.queries.filter((q) => q.key !== key);
    this.derived = this.derived.filter((d) => d.key !== key);
    this.releaseDimension(key);
    if (wasWindowed) this.resetScrub();
  }
  releaseDimension(key: string) {
    const fallback: Channels = { ...RELEASE, ...defaultsFor(this.data) };
    for (const c of CHANNELS) if (this.channels[c] === key) this.channels[c] = fallback[c];
  }

  // ---- a new corpus: EVERYTHING corpus-shaped resets ----
  // Anything indexed by, scored against, or named after the old corpus is meaningless here: filters name
  // cluster ids and category values that don't exist; a `set` filter and a selection are raw indices into a
  // different file; query dimensions carry cosine arrays of the old length; the window carries the old
  // dimension's units; dimProps key off dimension ids that may not recur. Carrying any of it forward opened
  // the new map already silently masked — the worst possible first impression of an "honest" instrument.
  mount(D: MapContract) {
    this.data = D;
    this.resetViewState();
  }
  // Everything view-shaped back to this corpus's defaults — shared by mount() and by `view.open`, which
  // must apply a saved state EXACTLY (residue from the view you were just in would make the opened view
  // a blend, not the one that was saved).
  resetViewState() {
    this.selected = null; this.pinned = null;
    this.selection = null; this.selectMode = false;
    this.filters = []; this.query = "";
    this.queries = []; this.qN = 0;
    this.derived = []; this.dN = 0;
    this.dimProps = {};
    this.channels = { ...INITIAL, ...defaultsFor(this.data) };
    this.scrubLo = null; this.scrubHi = null;
    this.grain = this.data?.di ?? 0;
  }

  // ---- the view state as ONE plain object (eid-thbs) ----
  // snapshot() is the single producer of the ViewState shape: the URL mirror serializes it (capped,
  // sparse), and `view.save` writes it into the .eido verbatim (full ids, no cap). Camera is App's —
  // it owns the deck handle — so App composes it in before saving.
  snapshot(): ViewState {
    const D = this.data;
    const s: ViewState = { layout: this.layout, channels: { ...this.channels }, grain: this.grain };
    if (Object.keys(this.dimProps).length) s.dimProps = { ...this.dimProps };
    if (this.scrubLo !== null || this.scrubHi !== null) {
      s.window = {};
      if (this.scrubLo !== null) s.window.lo = this.scrubLo;
      if (this.scrubHi !== null) s.window.hi = this.scrubHi;
    }
    // active filters: region (cluster) · facet (categorical value) · find (text). Each is at-most-one by construction.
    if (this.pinned !== null) s.region = this.pinned;
    if (this.facetPin !== null) s.facet = this.facetPin;
    const tf = this.filters.find((f) => f.kind === "text") as Extract<Filter, { kind: "text" }> | undefined; if (tf) s.find = tf.q;
    if (this.queries.length) s.queries = this.queries.map((q) => q.text);
    if (this.derived.length && D) s.derived = this.derived.map((d) => ({ label: d.label, key: d.key, ids: [...d.ids] }));
    if (this.selected !== null && D) s.card = D.ids[this.selected];
    if (this.selection?.length && D) s.selection = this.selection.map((i) => D.ids[i]);
    return s;
  }

  // ---- deep-linkable view state (eid-yxqu): the URL always mirrors the current view ----
  // Pure: takes the location pieces, returns the new path+query. App does the history.replaceState.
  // The URL is ONE ENCODING of snapshot() — sparse (defaults elided) and capped (id sets ride as
  // encoded index-sets and drop past SET_PARAM_CAP). The uncapped encoding is the saved view in the file.
  serializeUrl(pathname: string, search: string): string {
    const s = this.snapshot();
    const ch = s.channels ?? {};
    const p = new URLSearchParams();
    const m = new URLSearchParams(search).get("map"); if (m) p.set("map", m);
    if (s.layout && s.layout !== "mde") p.set("layout", s.layout);
    if (ch.color && ch.color !== "region") p.set("color", ch.color);
    if (ch.size && ch.size !== "hub") p.set("size", ch.size);
    if (this.data && s.grain !== undefined && s.grain !== (this.data.di ?? 0)) p.set("grain", String(s.grain));
    if (s.layout === "axes" || s.layout === "axes3d") { if (ch.x) p.set("x", ch.x); if (ch.y) p.set("y", ch.y); if (s.layout === "axes3d" && ch.z) p.set("z", ch.z); }
    // per-dimension props the user changed (norm/invert): key.<h|r><0|1>, comma-joined
    const dp = Object.entries(s.dimProps ?? {}); if (dp.length) p.set("props", dp.map(([k, v]) => k + "." + (v.norm === "rank" ? "r" : "h") + (v.invert ? "1" : "0")).join(","));
    // scrubber window (the range filter) — only when actually windowed
    if (s.window) { if (ch.scrub) p.set("sk", ch.scrub); if (s.window.lo !== undefined) p.set("slo", String(s.window.lo)); if (s.window.hi !== undefined) p.set("shi", String(s.window.hi)); }
    if (s.region !== undefined) p.set("region", String(s.region));
    if (s.facet !== undefined) p.set("facet", s.facet);
    if (s.find !== undefined) p.set("find", s.find);
    for (const q of s.queries ?? []) p.append("q", q);   // query dims by text (re-embedded on load, best-effort)
    // derived dims as <label>~<key>:<set> (re-derived on load). The KEY rides along so channels pointing at
    // the dim (color=d1) still name the same axis after a reload even if a sibling dim dropped — restoring
    // positionally renumbered the survivors and a shared view came back painted (and labeled) by the WRONG
    // axis. A dim minted from the shared selection references it (`s`) instead of repeating the ids. Past
    // the cap we serialize NOTHING and the pane says so — a URL-capacity concern only; the file has none.
    for (const dd of this.derived) { const pay = this.derivedPayload(dd); if (pay !== null) p.append("d", dd.label.replace(/~/g, "-") + "~" + dd.key + ":" + pay); }
    if (s.card !== undefined) p.set("card", s.card);
    // a held SELECTION rides as an encoded, checksummed index set (idset.ts) — compact, and the checksum
    // drops it cleanly on a corpus whose ids no longer match. Capped — past the cap we serialize NOTHING
    // and the UI says the selection is too large to share.
    if (this.selection?.length && this.data && this.selShareable && this.selEnc) p.set("sel", this.selEnc);
    const q = p.toString();
    return pathname + (q ? "?" + q : "");
  }
  // Apply the EAGER half of a restored state (URL or saved view). The deferred half (region/facet/find/
  // card, query embedding, set resolution) needs grain-derived state or async work, so App applies it
  // once the reactive graph has settled — the SAME App path for both carriers.
  applyPatch(p: StatePatch) {
    if (p.layout) this.layout = p.layout;
    const ch = p.channels ?? {};
    if (ch.color) this.channels.color = ch.color;
    if (ch.size) this.channels.size = ch.size;
    if (ch.x) this.channels.x = ch.x;
    if (ch.y) this.channels.y = ch.y;
    if (ch.z) this.channels.z = ch.z;
    if (ch.sort) this.channels.sort = ch.sort;
    if (p.grain !== undefined) this.grain = Math.max(0, Math.min((this.data?.counts?.length ?? 1) - 1, Math.round(p.grain)));
    if (p.dimProps) this.dimProps = p.dimProps;
    if (ch.scrub) this.channels.scrub = ch.scrub;
    if (p.window?.lo !== undefined) this.scrubLo = p.window.lo;
    if (p.window?.hi !== undefined) this.scrubHi = p.window.hi;
  }
}
