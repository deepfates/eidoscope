<script lang="ts">
  import { onMount, untrack } from "svelte";
  import RangeSlider from "svelte-range-slider-pips";
  import { loadMap, mapUrl, decodeEido } from "./loader";
  import { createMap, type MapHandle, type Layout } from "./deckmap";
  import { col, axisColor } from "./encode";
  import { buildDimensions, sizeAccessor, colorAccessor, scores01, defaultProps, type Dimension, type DimProps } from "./dimensions";
  import { embedQuery, cosineAll, resetEmbedder } from "./semantic";
  import type { MapContract } from "../../src/schema";

  let canvas: HTMLCanvasElement;
  let status = $state("loading your map…");
  let loadFailed = $state(false);
  let data = $state<MapContract | null>(null);
  let selected = $state<number | null>(null);
  let hovered = $state<{ kind: "point"; i: number; x: number; y: number } | { kind: "ghost"; g: any; x: number; y: number } | null>(null);
  let color = $state("region");
  let size = $state("hub");
  let layout = $state<Layout>("mde");
  let xKey = $state("");
  let yKey = $state("");
  let zKey = $state("");
  let handle = $state<MapHandle | null>(null);
  let showLabels = $state(true);
  let grain = $state(0);
  let pinned = $state<number | null>(null);
  let facetPin = $state<string | null>(null);   // isolated facet value (e.g. a folder) — study one lens at a time
  let deckOpen = $state(false);
  let deckSort = $state("hub");
  let deckQ = $state("");
  let deckUnread = $state(false);
  let query = $state("");
  let semQuery = $state("");                 // the query-box text (distinct from `query`, the substring find)
  let querying = $state(false);
  let queryErr = $state("");
  let queryStatus = $state("");   // live line while the first query downloads the model / embeds
  let queryPct = $state<number | null>(null);   // download % when known (drives the thin progress bar)
  // N semantic queries, each a first-class dimension: {key, text, raw cosines}. "+ query" appends one; it then
  // shows up in every channel menu like any other dimension. Filtering by a query = putting it on the scrubber.
  let queries = $state<{ key: string; text: string; raw: number[] }[]>([]);
  let qN = 0;                                 // monotonic id source for stable query keys
  let showIntro = $state(false);
  let citeOn = $state(false);
  let ghostsOn = $state(false);
  let theme = $state<"dark" | "light">("dark");
  let panelOpen = $state(true);   // control panel + legend collapse on small screens so the map is the hero
  let legendOpen = $state(true);
  // THE DIMENSION REGISTRY (grammar unification): one list of dimensions all channels draw from. Migrating
  // channels onto it one at a time — `size` first. dimProps holds per-dimension user overrides (norm/invert).
  let dimProps = $state<Record<string, DimProps>>({});
  // UNIFIED FILTER: one declarative list (facet membership · region cluster · text search). The scrubber range
  // is folded into the same intersection mask below. Declarative (not predicates) so it serializes and diffs.
  type Filter =
    | { kind: "cat"; key: string; label: string; value: string }   // categorical dimension = value
    | { kind: "region"; key: "region"; label: string; cluster: number } // cluster at the current grain
    | { kind: "text"; key: "text"; label: string; q: string };      // title/body substring
  let filters = $state<Filter[]>([]);
  const dimList = $derived(data ? buildDimensions(data) : []);
  const propsOf = (d: Dimension): DimProps => dimProps[d.key] ?? defaultProps(d);
  const sizeGet = (dims: Dimension[], key: string) => { const d = dims.find((x) => x.key === key); return sizeAccessor(d, d ? propsOf(d) : { norm: "honest", invert: false }); };
  // the active semantic query, as a query-kind dimension in the one registry (raw = its cosines). N queries later.
  const queryDims = $derived.by((): Dimension[] => queries.map((q) => ({ key: q.key, name: "⌕ " + q.text, kind: "scalar", source: "query", raw: q.raw, bipolar: false, low: "unrelated", high: q.text })));
  const allDims = $derived([...dimList, ...queryDims]);
  const colorDim = $derived(color === "region" ? undefined : allDims.find((d) => d.key === color)); // undefined = the region clustering
  const colorGet = (dims: Dimension[], key: string, assign: number[]) => { const d = dims.find((x) => x.key === key); return colorAccessor(d, d ? propsOf(d) : { norm: "honest", invert: false }, assign); };
  // position accessor: a chosen scalar dimension → per-card coord in -1..1 (its norm/invert applied). Axis-scatter only.
  const posGet = (dims: Dimension[], key: string) => { const d = dims.find((x) => x.key === key); if (!d || d.kind === "categorical") return () => 0; const s = scores01(d, propsOf(d)); return (i: number) => ((s[i] ?? 50) - 50) / 50; };
  const xDim = $derived(allDims.find((d) => d.key === xKey));
  const yDim = $derived(allDims.find((d) => d.key === yKey));
  const zDim = $derived(allDims.find((d) => d.key === zKey));
  const sizeDim = $derived(size === "uniform" ? undefined : allDims.find((d) => d.key === size));
  // Per-dimension norm/invert lives in dimProps (keyed by dim.key) so the props travel WITH the dimension —
  // toggling honest⇄rank on a dim changes it identically wherever it's placed (colour/size/x/y/z). One writer:
  function setProp(d: Dimension, patch: Partial<DimProps>) { dimProps = { ...dimProps, [d.key]: { ...propsOf(d), ...patch } }; }
  // The two poles of a scalar dim as [score-0 label, score-100 label]. scores01 applies invert, so when a dim is
  // inverted the labels swap too — keeping the legend/axis honest (the pole where a card sits matches its label).
  const poles = (d: Dimension): [string, string] => { const lo = d.low ?? "low " + d.name, hi = d.high ?? d.name; return propsOf(d).invert ? [hi, lo] : [lo, hi]; };
  // Position accessors are fresh closures each update but deckmap only recomputes positions on a KEY change —
  // so a prop-only change (same xKey, new norm) wouldn't move the points. This signature makes the change
  // observable: deckmap bumps posVer whenever posSig differs (a plain $derived — NOT a self-incrementing $effect,
  // which hung the app before). Includes each axis dim's props so honest⇄rank/invert on an axis re-lays-out.
  const posSig = $derived.by(() => {
    const sig = (k: string) => { const d = allDims.find((x) => x.key === k); return d ? [k, propsOf(d).norm, propsOf(d).invert] : [k]; };
    return JSON.stringify([sig(xKey), sig(yKey), sig(zKey)]);
  });
  function setTheme(t: "dark" | "light", persist = true) { theme = t; document.documentElement.dataset.theme = t; if (persist) try { localStorage.setItem("eido-theme", t); } catch {} }
  function toggleTheme() { setTheme(theme === "dark" ? "light" : "dark"); }
  const hasCite = $derived(!!data?.cite?.some((e) => e.length));
  const hasGhosts = $derived(!!data?.ghosts?.length);
  const sizeLabel = $derived(size === "hub" ? "influence" : size === "uniform" ? "uniform" : "axis");
  // history-synced overlays (eid-fktf): opening an overlay pushes a history entry, so Back — and the
  // mobile back gesture — closes the topmost one (the only intuitive way to escape deck/detail on a phone).
  let overlayPushed = false;
  function doCloseOverlays() { if (showIntro) { try { localStorage.setItem("eido-seen", "1"); } catch {} } showIntro = false; deckOpen = false; if (selected !== null) focusCard(null); }
  function requestClose() { if (overlayPushed) { try { history.back(); return; } catch {} } doCloseOverlays(); }
  function dismissIntro() { requestClose(); }
  $effect(() => { const anyOpen = showIntro || deckOpen || selected !== null; if (anyOpen && !overlayPushed) { try { history.pushState({ eido: 1 }, ""); } catch {} overlayPushed = true; } });
  const hasRead = $derived(!!data?.read?.some((r) => r === true || r === false));
  const axShort = (name: string) => name.split(/ vs\.? | and /i)[0].slice(0, 15);
  const deckList = $derived.by(() => {
    if (!data) return [] as number[];
    let list = data.ids.map((_, i) => i);
    const q = deckQ.trim().toLowerCase();
    if (q) list = list.filter((i) => data!.titles[i].toLowerCase().includes(q) || data!.cores[i].toLowerCase().includes(q));
    if (deckUnread && hasRead) list = list.filter((i) => data!.read![i] !== true);
    const sd = allDims.find((x) => x.key === deckSort);   // sort by any scalar dimension (influence, length, axis, query…)
    const sv = sd && sd.kind !== "categorical" ? scores01(sd, propsOf(sd)) : null;
    if (sv) list.sort((a, b) => (sv[b] ?? 0) - (sv[a] ?? 0));
    return list.slice(0, 2000);  // show the whole corpus (was 300 — which hid most cards + masked "unread only")
  });
  const labelsOn = $derived(showLabels && color === "region");  // 3D now has proper billboarded region labels (isomorphic with 2D)
  const nLevels = $derived(data?.counts?.length ?? 1);
  const assignment = $derived(data?.levels?.[grain] ?? data?.cluster ?? []);
  const curCount = $derived(data?.counts?.[grain] ?? data?.k ?? 0);
  const curClusters = $derived.by(() => {
    if (!data) return [] as { c: number; label: string; n: number }[];
    const a = assignment, k = curCount, labels = data.levelLabels?.[grain];
    const cnt = new Array(k).fill(0); for (const c of a) if (c >= 0 && c < k) cnt[c]++;
    return Array.from({ length: k }, (_, c) => ({ c, label: labels?.[c] ?? data!.clusters[c]?.label ?? "region " + c, n: cnt[c] }));
  });
  const membersOf = (c: number) => { const out: number[] = []; assignment.forEach((v, i) => { if (v === c) out.push(i); }); return out; };
  // Region isolate = a hard filter on the cluster at the current grain (keeps `pinned` for legend styling/hover).
  function togglePin(c: number) {
    const i = filters.findIndex((f) => f.kind === "region" && f.cluster === c);
    if (i >= 0) { filters = filters.filter((_, j) => j !== i); pinned = null; handle?.resetView(); }
    else { filters = [...filters.filter((f) => f.kind !== "region"), { kind: "region", key: "region", label: curClusters.find((x) => x.c === c)?.label ?? "region " + c, cluster: c }]; pinned = c; handle?.fitToIndices(membersOf(c)); }
  }
  const facetMembers = (v: string) => { const out: number[] = []; const d = colorDim; if (!d?.cat || !data) return out; for (let i = 0; i < data.ids.length; i++) if (d.cat(i) === v) out.push(i); return out; };
  // Facet isolate = a hard filter on the colour dimension's value (keeps `facetPin` for legend styling).
  function toggleFacetPin(v: string) {
    const key = colorDim?.key; if (!key) return;
    const i = filters.findIndex((f) => f.kind === "cat" && f.key === key && f.value === v);
    if (i >= 0) { filters = filters.filter((_, j) => j !== i); facetPin = null; handle?.resetView(); }
    else { filters = [...filters.filter((f) => !(f.kind === "cat" && f.key === key)), { kind: "cat", key, label: v, value: v }]; facetPin = v; handle?.fitToIndices(facetMembers(v)); }
  }
  function removeFilter(f: Filter) { filters = filters.filter((x) => x !== f); if (f.kind === "region") pinned = null; if (f.kind === "cat") facetPin = null; if (f.kind === "text") query = ""; }
  function clearFilters() { filters = []; pinned = null; facetPin = null; query = ""; resetScrub(); }
  // switching the colour lens drops stale facet filters (a folder value means nothing under a different lens)
  let lastColorForFacet = color;
  $effect(() => { const c = color; if (c !== lastColorForFacet) { lastColorForFacet = c; const cur = untrack(() => colorDim?.key); untrack(() => { const next = filters.filter((f) => f.kind !== "cat" || f.key === cur); if (next.length !== filters.length) { filters = next; facetPin = null; } }); } });

  const pct = (a: any) => (a?.variance != null ? Math.round(a.variance * 100) : null);
  // axis label with its STRENGTH up front (variance %, ~ for weak) — the % stays visible even when the
  // long name truncates in a narrow dropdown, so you can tell a strong dimension from a thin one (eid-4vm2).
  const axl = (a: any) => (pct(a) != null ? (a.weak ? "~" : "") + pct(a) + "% " : a.weak ? "~ " : "") + a.name;
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const trunc = (s: string, m = 44) => (s && s.length > m ? s.slice(0, m - 1) + "…" : s);
  const regionOf = (i: number) => curClusters[assignment[i]]?.label ?? "";
  const readerLabel = (u?: string) => (u && /readwise\.io/.test(u) ? "Readwise" : "open");
  const sourceLabel = (i: number) => data?.siteNames?.[i] || "original";
  const dateOf = (i: number) => { const d = data?.dates?.[i]; return d ? new Date(d).toISOString().slice(0, 10) : ""; };
  const placements = (i: number) =>
    data ? data.axes.map((a) => ({ a, s: Math.round(data!.scores[a.key]?.[i] ?? 50), note: data!.notes[i]?.[a.key] || "" }))
      .filter((x) => x.note).sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 6) : [];
  const topAxes = (i: number) =>
    data ? data.axes.map((a) => ({ n: a.name, s: Math.round(data!.scores[a.key]?.[i] ?? 50) }))
      .sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 3) : [];

  function focusCard(i: number | null) { selected = i; handle?.setFocus(i); }
  function reset() { focusCard(null); clearFilters(); handle?.setHighlight(null); grain = data?.di ?? 0; handle?.resetView(); }

  // deep-linkable view state (eid-yxqu): the URL always mirrors the current view, so any view — or a
  // specific card — is a shareable link and a reload restores it. replaceState (not push) so it doesn't
  // fight the overlay history (fktf); the ?map= param is preserved.
  let urlReady = false;
  function serializeUrl(): string {
    const p = new URLSearchParams();
    const m = new URLSearchParams(location.search).get("map"); if (m) p.set("map", m);
    if (layout !== "mde") p.set("layout", layout);
    if (color !== "region") p.set("color", color);
    if (size !== "hub") p.set("size", size);
    if (data && grain !== (data.di ?? 0)) p.set("grain", String(grain));
    if (layout === "axes" || layout === "axes3d") { if (xKey) p.set("x", xKey); if (yKey) p.set("y", yKey); if (layout === "axes3d" && zKey) p.set("z", zKey); }
    // per-dimension props the user changed (norm/invert): key.<h|r><0|1>, comma-joined
    const dp = Object.entries(dimProps); if (dp.length) p.set("props", dp.map(([k, v]) => k + "." + (v.norm === "rank" ? "r" : "h") + (v.invert ? "1" : "0")).join(","));
    // scrubber window (the range filter) — only when actually windowed
    if (scrubLo !== null || scrubHi !== null) { if (scrubKey) p.set("sk", scrubKey); if (scrubLo !== null) p.set("slo", String(scrubLo)); if (scrubHi !== null) p.set("shi", String(scrubHi)); }
    // active filters: region (cluster) · facet (categorical value) · find (text). Each is at-most-one by construction.
    if (pinned !== null) p.set("region", String(pinned));
    if (facetPin !== null) p.set("facet", facetPin);
    const tf = filters.find((f) => f.kind === "text") as Extract<Filter, { kind: "text" }> | undefined; if (tf) p.set("find", tf.q);
    for (const qq of queries) p.append("q", qq.text);   // query dims by text (re-embedded on load, best-effort)
    if (selected !== null && data) p.set("card", data.ids[selected]);
    const q = p.toString();
    return location.pathname + (q ? "?" + q : "");
  }
  function applyUrlState() {
    const p = new URLSearchParams(location.search);
    const L = p.get("layout"); if (L === "mde" || L === "axes" || L === "orbit" || L === "axes3d") layout = L;
    const c = p.get("color"); if (c) { color = c; lastColorForFacet = c; }  // keep the facet-clear effect from firing on this restore
    const s = p.get("size"); if (s) size = s;
    const x = p.get("x"); if (x) xKey = x;
    const y = p.get("y"); if (y) yKey = y;
    const z = p.get("z"); if (z) zKey = z;
    const g = p.get("grain"); if (g && !Number.isNaN(+g)) grain = Math.max(0, Math.min((data?.counts?.length ?? 1) - 1, Math.round(+g)));
    // per-dimension props (norm/invert)
    const props = p.get("props"); if (props) { const next: Record<string, DimProps> = {}; for (const e of props.split(",")) { const dot = e.lastIndexOf("."); const k = e.slice(0, dot), code = e.slice(dot + 1); if (k && code.length >= 2 && (code[0] === "r" || code[0] === "h")) next[k] = { norm: code[0] === "r" ? "rank" : "honest", invert: code[1] === "1" }; } dimProps = next; }
    // scrubber window
    const sk = p.get("sk"); if (sk) scrubKey = sk;
    const slo = p.get("slo"), shi = p.get("shi");
    if (slo !== null && !Number.isNaN(+slo)) scrubLo = +slo;
    if (shi !== null && !Number.isNaN(+shi)) scrubHi = +shi;
    if (slo !== null || shi !== null) scrubNonce++;   // remount the slider so its thumbs show the restored window
    // re-embed query dimensions from their text (best-effort, background; won't block the restore or hang the app)
    for (const t of p.getAll("q")) embedAndAdd(t, false);
    // region + card + facet + find depend on grain-derived state, so apply once the reactive graph has settled
    queueMicrotask(() => {
      const r = p.get("region"); if (r && !Number.isNaN(+r) && +r >= 0 && +r < curCount) togglePin(+r);
      const fp = p.get("facet"); if (fp && colorDim?.ord?.includes(fp)) toggleFacetPin(fp);
      const find = p.get("find"); if (find) onFind(find);
      const card = p.get("card"); if (card && data) { const i = data.ids.indexOf(card); if (i >= 0) focusCard(i); }
    });
  }
  $effect(() => { void [layout, color, size, grain, xKey, yKey, zKey, pinned, selected, scrubKey, scrubLo, scrubHi, dimProps, filters, queries]; if (urlReady) { try { history.replaceState(history.state, "", serializeUrl()); } catch {} } });

  // focus-trap action (eid-vxm2): on open, move focus into the modal + keep Tab inside it (so keyboard
  // focus can't wander to the background controls behind the overlay); on close, return focus to the opener.
  function trapFocus(node: HTMLElement) {
    const opener = document.activeElement as HTMLElement | null;
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const items = () => [...node.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
    queueMicrotask(() => { const f = items(); (f[0] ?? node).focus(); });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = items(); if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !node.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return { destroy() { node.removeEventListener("keydown", onKey); try { opener?.focus(); } catch {} } };
  }

  // Bring a decoded map onto the canvas — used for the first load AND for opening a new file/url at runtime,
  // so the viewer is a general .eido opener, not welded to one bundled map. Tears down the old GPU context,
  // resets per-corpus selection, re-wires the createMap handle + the read-only __eido test seam.
  let dragOver = $state(false);
  function mountMap(D: MapContract, opts?: { intro?: boolean }) {
    handle?.destroy();                                   // free the previous deck's GPU context before recreating
    selected = null; pinned = null; facetPin = null;      // per-corpus state doesn't carry across files
    xKey = D.axes[0]?.key ?? "";
    yKey = D.axes[1]?.key ?? D.axes[0]?.key ?? "";
    zKey = D.axes[2]?.key ?? D.axes[0]?.key ?? "";
    grain = D.di ?? 0;
    data = D;
    status = "";
    if (opts?.intro) showIntro = true;                    // a freshly-opened file introduces itself
    handle = createMap(canvas, D, {
      getColor: colorGet(buildDimensions(D), color, D.levels?.[grain] ?? D.cluster), getRadius: sizeGet(buildDimensions(D), size), getX: posGet(buildDimensions(D), xKey), getY: posGet(buildDimensions(D), yKey), getZ: posGet(buildDimensions(D), zKey), posSig, layout, xKey, yKey, zKey, showLabels: labelsOn, grain, theme,
      onClick: (i) => focusCard(i < 0 ? null : i),
      onHover: (h, x, y) => (hovered = h == null ? null : { ...h, x, y }),
      onGrainChange: (g) => { grain = g; pinned = null; },
    });
    // read-only introspection seam for the integration suite (drives the REAL built app, asserts real state)
    (window as any).__eido = () => { const d = handle?.debug(); return { grain, k: curCount, layout, color, pin: pinned, facetPin, focus: selected, detail: selected !== null, deckOpen, cite: citeOn, ghosts: ghostsOn, theme, hover: hovered ? hovered.kind : null, zoom: d?.zoom ?? 0, labels: d?.labels ?? 0, regions: d?.regions ?? 0, rot: d?.rot ?? null, rotX: d?.rotX ?? null, target: d?.target ?? null, span3: d?.span3 ?? null, filters: chips.map((c) => c.label), visible: filterMask ? filterMask.reduce((a, v) => a + v, 0) : (data?.ids.length ?? 0) }; };
    (window as any).__eidoProject = (xy: number[]) => handle?.project(xy);
    (window as any).__eidoPick = (x: number, y: number) => handle?.pickAt(x, y);
  }
  // Semantic query: embed in-browser (same model that made the card vectors), cosine-rank, and append a
  // query-kind DIMENSION. It then appears in every channel menu (color/size/x/y/z/scrubber/deck-sort) like any
  // other dimension — no bespoke plumbing. N queries coexist. To hide low-similarity cards, put the query on the scrubber.
  // embed a text query → append a query-kind dimension; returns its key (or null). grabColor: colour by it (the
  // interactive payoff); URL-restore passes false so it doesn't steal a colour channel the URL already set.
  async function embedAndAdd(q: string, grabColor: boolean): Promise<string | null> {
    const D = data; if (!D?.vectors || !q) return null;
    querying = true; queryErr = ""; queryStatus = "loading model…"; queryPct = null;
    // The first query lazy-loads a ~23MB model from a CDN. Show live progress, and detect a genuine STALL (no
    // progress for a while) vs. merely-slow — so a throttled/hung download surfaces a retry instead of freezing.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let onStall!: (e: Error) => void;
    const stalled = new Promise<never>((_, rej) => (onStall = rej));
    const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => onStall(new Error("__stall__")), 40000); };
    armStall();
    try {
      const qv = await Promise.race([
        embedQuery(q, (D as any).derivedBy?.embedder?.id, (p) => { queryStatus = p.label; queryPct = p.pct ?? null; armStall(); }),
        stalled,
      ]);
      const key = "q" + qN++;
      queries = [...queries, { key, text: q, raw: cosineAll(qv, D.vectors) }];
      if (grabColor) color = key;
      queryStatus = "";
      return key;
    } catch (e: any) {
      resetEmbedder();   // drop the poisoned/half-loaded model so the next ⌕ retries cleanly
      queryErr = e?.message === "__stall__"
        ? "model download stalled — check your connection, then press ⌕ to retry"
        : "couldn’t run the query (" + String(e?.message ?? e) + ") — press ⌕ to retry";
      queryStatus = "";
      return null;
    } finally { clearTimeout(stallTimer); querying = false; }
  }
  async function runQuery() { const q = semQuery.trim(); if (!q) return; semQuery = ""; await embedAndAdd(q, true); }
  // remove a query dimension; reset any channel that was pointing at it back to a default.
  function removeQuery(key: string) {
    queries = queries.filter((q) => q.key !== key);
    if (color === key) color = "region";
    if (size === key) size = "uniform";
    if (deckSort === key) deckSort = "hub";
    if (scrubKey === key) scrubKey = "";
    if (xKey === key) xKey = data?.axes[0]?.key ?? "";
    if (yKey === key) yKey = data?.axes[1]?.key ?? "";
    if (zKey === key) zKey = data?.axes[2]?.key ?? "";
  }
  async function openFile(file: File) {
    try {
      status = "opening " + file.name + "…"; loadFailed = false;
      mountMap(await decodeEido(new Uint8Array(await file.arrayBuffer())), { intro: true });
    } catch (e: any) { loadFailed = true; status = "couldn't open " + file.name + " — " + (e?.message ?? e); }
  }
  function onDrop(e: DragEvent) { e.preventDefault(); dragOver = false; const f = e.dataTransfer?.files?.[0]; if (f && /\.eido$/i.test(f.name)) openFile(f); }

  onMount(() => {
    try {
      const saved = localStorage.getItem("eido-theme");
      if (saved === "light" || saved === "dark") setTheme(saved, false);
      else theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {}
    try { const mq = matchMedia("(max-width: 640px)"); if (mq.matches) { panelOpen = false; legendOpen = false; } mq.addEventListener("change", (e) => { if (e.matches) { panelOpen = false; legendOpen = false; } }); } catch {}
    (async () => {
      try {
        const D = await loadMap(mapUrl());
        try { showIntro = !localStorage.getItem("eido-seen"); } catch { showIntro = true; }
        mountMap(D);
        applyUrlState(); urlReady = true;  // restore any deep-linked view/card, then start mirroring state → URL
      } catch (e: any) {
        loadFailed = true;
        status = "couldn't load the map — " + (e?.message ?? e);
      }
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    const onPop = () => { overlayPushed = false; doCloseOverlays(); };  // Back / mobile back gesture closes the overlay
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => { handle?.destroy(); window.removeEventListener("keydown", onKey); window.removeEventListener("popstate", onPop); };
  });

  $effect(() => {
    const l = layout, c = color, s = size, xk = xKey, yk = yKey, zk = zKey, sl = labelsOn, g = grain, a = assignment, co = citeOn, go = ghostsOn, th = theme, h = handle, d = data, ad = allDims, dp = dimProps, ps = posSig;
    void dp; // dimProps in deps so a norm/invert change re-pushes the accessors
    if (h && d) h.update({ getColor: colorGet(ad, c, a), getRadius: sizeGet(ad, s), getX: posGet(ad, xk), getY: posGet(ad, yk), getZ: posGet(ad, zk), posSig: ps, layout: l, xKey: xk, yKey: yk, zKey: zk, showLabels: sl, grain: g, citeOn: co, ghostsOn: go, theme: th });
  });
  // text search = a filter (hard hide), synced from the find box below via onFind — no separate deck path.
  function onFind(v: string) { query = v; const q = v.trim(); const others = filters.filter((f) => f.kind !== "text"); filters = q ? [...others, { kind: "text", key: "text", label: "“" + q + "”", q }] : others; }

  // SCRUBBER (channel grammar): ONE slider that reveals cards cumulatively along ANY scalar/temporal field —
  // date, length, influence, citation impact, or a discovered axis — chosen from D.metaFields, via deck's GPU
  // DataFilterExtension. Falls back to a date scrubber for pre-metaFields (v1) files.
  let scrubLo = $state<number | null>(null);  // window lower bound; null = field min
  let scrubHi = $state<number | null>(null);  // window upper bound; null = field max (both null = show everything)
  let scrubKey = $state("");
  // svelte-range-slider-pips mutates its `values` array in place, which Svelte 5's bind-bridge doesn't write
  // back — so bind:values can't capture drags. Instead the slider is one-way (values from scrubLo/Hi) with an
  // on:change writer, and this nonce force-REMOUNTS it on any external reset so the thumbs re-read fresh state.
  let scrubNonce = $state(0);
  function resetScrub() { scrubLo = null; scrubHi = null; scrubNonce++; }
  const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  const scrubFields = $derived(allDims.filter((d) => d.kind === "scalar" || d.kind === "temporal"));  // registry
  $effect(() => { if (!scrubKey && scrubFields.length) scrubKey = (scrubFields.find((d) => d.kind === "temporal") ?? scrubFields[0]).key; });
  const scrubField = $derived(scrubFields.find((d) => d.key === scrubKey));
  const scrubVals = $derived(scrubField?.raw ?? null);  // window on the dimension's raw values (dates/counts/scores)
  const scrubRange = $derived.by((): [number, number] | null => {
    if (!scrubVals) return null;
    let lo = Infinity, hi = -Infinity;
    for (const v of scrubVals) if (typeof v === "number") { if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi > lo ? [lo, hi] : null;
  });
  // scrubLo/scrubHi stay null = "show everything" until dragged (they READ `?? min/max`, WRITE only on input,
  // so they never write a default back on mount — the race that emptied the map on load).
  // The scrubber is a RANGE FILTER on the scrubbed dimension: when windowed, it contributes a test to the same
  // intersection mask as the discrete (facet/region/text) filters — one filter primitive, one deck path.
  const scrubTest = $derived.by((): ((i: number) => boolean) | null => {
    const r = scrubRange, vs = scrubVals, lo = scrubLo, hi = scrubHi;
    if (!r || !vs) return null;
    if (!((lo != null && lo > r[0]) || (hi != null && hi < r[1]))) return null; // wide open = no filter
    const L = lo ?? r[0], H = hi ?? r[1];
    return (i) => { const v = vs[i]; return typeof v === "number" && v >= L && v <= H; };
  });
  // Build a per-filter test from the declarative record (categorical membership / region cluster / substring).
  function filterTest(f: Filter): (i: number) => boolean {
    if (!data) return () => true;
    if (f.kind === "text") { const s = f.q.toLowerCase(), T = data.titles, C = data.cores; return (i) => T[i].toLowerCase().includes(s) || C[i].toLowerCase().includes(s); }
    if (f.kind === "region") { const a = assignment; return (i) => a[i] === f.cluster; }
    const d = allDims.find((x) => x.key === f.key); if (!d?.cat) return () => true; return (i) => d.cat!(i) === f.value;
  }
  // THE intersection mask: 1 = passes EVERY active filter (discrete + scrubber), 0 = hidden. null = nothing active.
  const filterMask = $derived.by((): Uint8Array | null => {
    if (!data) return null;
    const tests = filters.map(filterTest); const st = scrubTest; if (st) tests.push(st);
    if (!tests.length) return null;
    const n = data.ids.length, m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = tests.every((t) => t(i)) ? 1 : 0;
    return m;
  });
  $effect(() => { const h = handle, m = filterMask; if (h) h.setFilterMask(m); });  // push the mask (pure derived → no write-loop)
  // Active filters as removable chips (the scrubber window is one too, so clear/remove works uniformly).
  const chips = $derived.by((): { label: string; remove: () => void }[] => {
    const out = filters.map((f) => ({ label: f.label, remove: () => removeFilter(f) }));
    if (scrubTest && scrubField) out.push({ label: scrubField.name + " window", remove: resetScrub });
    return out;
  });

  const hint = $derived(layout === "axes" ? "positioned by where each card projects on the two axes" : layout === "axes3d" ? "three axes on x/y/z · drag to rotate · scroll to zoom" : layout === "orbit" ? "drag to rotate · scroll to zoom" : "proximity = similarity · tap a card");
  const prov = $derived(data?.provenance);   // so a passed-around file introduces itself
  const provDate = (g?: number) => (g ? new Date(g).toISOString().slice(0, 10) : "");
  $effect(() => { try { document.title = prov?.title ? `${prov.title} · eidoscope 🔭` : "eidoscope 🔭"; } catch {} });
  const weakAxes = $derived(layout === "axes" ? (xDim?.weak ? 1 : 0) + (yDim?.weak ? 1 : 0) : 0);
</script>

<div class="relative h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--ink)] touch-none"
  role="application" aria-label="eidoscope map — drop a .eido file to open it"
  ondragover={(e) => { e.preventDefault(); dragOver = true; }} ondragleave={() => (dragOver = false)} ondrop={onDrop}>
 {#if dragOver}
  <div class="pointer-events-none absolute inset-0 z-[60] grid place-items-center bg-[var(--bg)]/70 backdrop-blur-sm">
   <div class="rounded-lg border-2 border-dashed border-[var(--ink)]/40 px-8 py-6 font-mono text-sm">drop a <b>.eido</b> to open it</div>
  </div>
 {/if}
  <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
  <!-- role="img"+aria-label is the intended pattern: present the canvas as one labeled image and route AT users to the deck list (the real accessible surface) -->
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full" role="img" aria-label="Document similarity map (visual). Use the deck list for a screen-reader-accessible view of the same cards."></canvas>

  {#if status}
    <div class="absolute inset-0 z-50 grid place-items-center bg-[var(--bg)] px-6">
      <div class="flex max-w-sm flex-col items-center gap-3 text-center font-mono text-sm">
        {#if !loadFailed}<div class="h-6 w-6 animate-spin rounded-full border-2 border-[var(--hair2)] border-t-[var(--accent)]" aria-hidden="true"></div>{/if}
        <div class="{loadFailed ? 'text-[var(--ink)]' : 'text-[var(--dim)]'}" role="status">{status}</div>
        {#if loadFailed}<button class="rounded-md border border-[var(--hair2)] px-3 py-1.5 text-xs text-[var(--soft)] hover:bg-[var(--chip)]" onclick={() => location.reload()}>reload</button>{/if}
      </div>
    </div>
  {/if}

  {#if data}
    {#if layout === "axes" && xDim && yDim}
      {@const xp = poles(xDim)}{@const yp = poles(yDim)}
      <div class="pointer-events-none absolute inset-0 font-mono text-xs text-[var(--dim)]">
        <div class="absolute left-3 top-1/2 max-w-[42%] -translate-y-1/2" title={xp[0]}>← {trunc(xp[0])}</div>
        <div class="absolute right-3 top-1/2 max-w-[42%] -translate-y-1/2 text-right" title={xp[1]}>{trunc(xp[1])} →</div>
        <div class="absolute left-1/2 top-3 max-w-[60%] -translate-x-1/2 truncate" title={yp[1]}>↑ {trunc(yp[1])}</div>
        <div class="absolute bottom-9 left-1/2 max-w-[60%] -translate-x-1/2 truncate" title={yp[0]}>↓ {trunc(yp[0])}</div>
      </div>
    {/if}

    <div class="absolute left-3 top-3 w-[min(14rem,calc(100vw-1.5rem))] rounded-xl border border-[var(--hair)] bg-[var(--panel)] p-3 backdrop-blur">
      <div class="flex items-center justify-between gap-2 {panelOpen ? 'mb-2' : ''}">
        <button class="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-[var(--faint)] hover:text-[var(--ink)]" onclick={() => (panelOpen = !panelOpen)} aria-expanded={panelOpen} aria-label="{panelOpen ? 'collapse' : 'expand'} controls"><span class="text-[9px]">{panelOpen ? "▾" : "▸"}</span> eidoscope 🔭</button>
        <div class="flex items-center gap-1.5">
          {#if !panelOpen}<button class="rounded-md border border-[var(--hair)] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--soft)] hover:bg-[var(--chip)]" onclick={() => (deckOpen = true)}>deck</button>{/if}
          <button class="rounded-md border border-[var(--hair)] px-1.5 py-0.5 text-[11px] leading-none hover:bg-[var(--chip)]" onclick={toggleTheme} aria-label="toggle light or dark theme" title="toggle theme">{theme === "dark" ? "☾" : "☀"}</button>
        </div>
      </div>
      {#if panelOpen}
      {#snippet propToggle(d: Dimension | undefined)}
        {#if d && (d.kind === "scalar" || d.kind === "temporal")}
          {@const p = propsOf(d)}
          <span class="flex flex-none gap-0.5">
            <!-- discovered axes are rank-normalized positions by design (even, readable spread); norm isn't a
                 user choice there, so only metrics/queries get the honest⇄rank toggle. invert applies to all. -->
            {#if !d.fixedNorm}
              <button onclick={() => setProp(d, { norm: p.norm === "rank" ? "honest" : "rank" })}
                title={p.norm === "rank" ? "rank-normalized: even spread — click for honest (true magnitudes; the skew shows)" : "honest: true magnitudes — click for rank (even spread)"}
                class="rounded border border-[var(--hair2)] px-1 py-0.5 font-mono text-[9px] {p.norm === 'rank' ? 'text-[var(--faint)]' : 'bg-[var(--chip)] text-[var(--ink)]'}">{p.norm === "rank" ? "rank" : "honest"}</button>
            {/if}
            <button onclick={() => setProp(d, { invert: !p.invert })}
              title={p.invert ? "inverted (high↔low) — click to restore" : "invert this dimension (high↔low)"}
              class="rounded border border-[var(--hair2)] px-1 py-0.5 font-mono text-[9px] {p.invert ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}">⇅</button>
          </span>
        {/if}
      {/snippet}
      {#if prov?.title}<div class="-mt-1 mb-0.5 truncate text-sm font-bold text-[var(--ink)]" title={prov.source ?? ""}>{prov.title}</div>{/if}
      <div class="mb-2 text-xs text-[var(--dim)]">{data.ids.length} cards · {curCount} regions</div>
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">layout</span>
        <select bind:value={layout} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="mde">neighbor map</option><option value="axes">axis scatter</option><option value="orbit">3D space</option><option value="axes3d">3D axis scatter</option>
        </select></label>
      {#if layout === "axes" || layout === "axes3d"}
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">x-axis</span>
          <select bind:value={xKey} title={xDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(xDim)}</label>
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">y-axis</span>
          <select bind:value={yKey} title={yDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(yDim)}</label>
        {#if layout === "axes3d"}
          <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">z-axis</span>
            <select bind:value={zKey} title={zDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(zDim)}</label>
        {/if}
        {#if weakAxes}<div class="mb-1.5 rounded-md bg-[var(--chip2)] px-2 py-1 text-[10px] leading-snug text-[var(--dim)]">~ {weakAxes > 1 ? "minor axes" : "a minor axis"} (under 2% variance) — position is thin, read it loosely</div>{/if}
      {/if}
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">color</span>
        <select bind:value={color} title={colorDim?.name ?? "region"} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="region">region</option>{#each allDims.filter((d) => d.kind === "categorical") as d}<option value={d.key}>{d.name}</option>{/each}{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.source === "axis" ? "axis: " + d.name : d.name}</option>{/each}
        </select>{@render propToggle(colorDim)}</label>
      <label class="flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">size</span>
        <select bind:value={size} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="uniform">uniform</option>{#each allDims.filter((d) => d.kind === "scalar") as d}<option value={d.key}>{d.name}</option>{/each}
        </select>{@render propToggle(sizeDim)}</label>
      {#if nLevels > 1}
        <label class="mt-2 flex items-center gap-2 text-xs">
          <span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">grain</span>
          <input type="range" min="0" max={nLevels - 1} bind:value={grain} oninput={() => (pinned = null)} class="min-w-0 flex-1 accent-[var(--accent)]" aria-label="grain level: how finely the map is divided into regions" aria-valuetext="{curCount} regions" />
          <span class="w-6 flex-none text-right font-mono text-[10px] text-[var(--faint)]">{curCount}</span>
        </label>
      {/if}
      {#if scrubFields.length && scrubRange && scrubField}
        <div class="mt-2">
          <div class="mb-1 flex items-center gap-2 text-xs">
            <select bind:value={scrubKey} onchange={resetScrub} title="which scalar/temporal dimension the scrubber windows" class="w-[72px] flex-none rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1 py-1 font-mono text-[10px] text-[var(--faint)]">{#each scrubFields as f}<option value={f.key}>{f.name}</option>{/each}</select>
            <span class="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-[var(--faint)]">{scrubField.kind === "temporal" ? fmtDate(scrubLo ?? scrubRange[0]) + " – " + fmtDate(scrubHi ?? scrubRange[1]) : Math.round(scrubLo ?? scrubRange[0]) + " – " + Math.round(scrubHi ?? scrubRange[1])}</span>
          </div>
          <div class="scrub">
            {#key scrubNonce}
              <RangeSlider range id="scrubber" min={scrubRange[0]} max={scrubRange[1]} step={(scrubRange[1] - scrubRange[0]) / 240} values={[scrubLo ?? scrubRange[0], scrubHi ?? scrubRange[1]]}
                on:change={(e) => { const [lo, hi] = e.detail.values; scrubLo = lo > scrubRange![0] ? lo : null; scrubHi = hi < scrubRange![1] ? hi : null; }} />
            {/key}
          </div>
        </div>
      {/if}
      <div class="mt-2 flex gap-2">
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={() => (deckOpen = true)}>deck</button>
        <button disabled={color !== "region"} title={color !== "region" ? "region labels show when coloured by region" : ""} class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] disabled:opacity-40 disabled:cursor-not-allowed {showLabels && color === 'region' ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (showLabels = !showLabels)}>labels</button>
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={reset}>reset</button>
      </div>
      <input type="search" value={query} oninput={(e) => onFind(e.currentTarget.value)} placeholder="find a card…" class="mt-2 w-full rounded-md border border-[var(--hair2)] bg-[var(--field)] px-2 py-1.5 text-xs" />
      {#if chips.length}
        <div class="mt-2 flex flex-wrap items-center gap-1">
          {#each chips as chip}
            <button onclick={chip.remove} title="remove filter" class="flex items-center gap-1 rounded-full border border-[var(--hair2)] bg-[var(--chip)] px-2 py-0.5 font-mono text-[10px] text-[var(--soft)] hover:text-[var(--ink)]"><span class="max-w-[9rem] truncate">{chip.label}</span> <span class="text-[var(--faint)]">✕</span></button>
          {/each}
          {#if chips.length > 1}<button onclick={clearFilters} title="clear all filters" class="rounded-full px-2 py-0.5 font-mono text-[10px] text-[var(--faint)] hover:text-[var(--ink)]">clear all</button>{/if}
        </div>
      {/if}
      {#if data?.vectors}
        <div class="mt-2 flex gap-1">
          <input bind:value={semQuery} onkeydown={(e) => e.key === "Enter" && runQuery()} placeholder="+ semantic axis…" disabled={querying} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-2 py-1.5 text-xs" />
          <button onclick={runQuery} disabled={querying || !semQuery.trim()} title="embed & add a query dimension you can place on any channel" class="flex-none rounded-md border border-[var(--hair2)] px-2.5 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]">{querying ? "…" : "⌕"}</button>
        </div>
        {#if querying}
          <div class="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--faint)]">
            <span class="inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-[var(--accent)]"></span>
            <span class="min-w-0 flex-1 truncate">{queryStatus || "working…"}</span>
          </div>
          {#if queryPct != null}<div class="mt-0.5 h-0.5 w-full overflow-hidden rounded bg-[var(--chip2)]"><div class="h-full bg-[var(--accent)] transition-all duration-200" style="width:{queryPct}%"></div></div>{/if}
        {:else if queryErr}
          <div class="mt-1 text-[10px] leading-snug text-red-400">{queryErr}</div>
        {:else if !queryDims.length}
          <div class="mt-1 text-[10px] leading-snug text-[var(--faint)]">first query downloads a small model once (~23 MB), then it’s instant</div>
        {/if}
        {#each queryDims as qd}
          <div class="mt-1 flex items-center gap-1 rounded-md bg-[var(--chip2)] px-2 py-1 text-[10px]">
            <span class="min-w-0 flex-1 truncate font-mono text-[var(--dim)]" title={qd.name}>{qd.name}</span>
            <button onclick={() => (color = qd.key)} title="colour by this query" class="flex-none font-mono text-[var(--faint)] hover:text-[var(--ink)]">●</button>
            <button onclick={() => removeQuery(qd.key)} title="remove query" class="flex-none font-mono text-[var(--faint)] hover:text-[var(--ink)]">✕</button>
          </div>
        {/each}
      {/if}
      {#if hasCite || hasGhosts}
        <div class="mt-2 flex gap-2">
          {#if hasCite}<button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] {citeOn ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (citeOn = !citeOn)}>cite edges</button>{/if}
          {#if hasGhosts}<button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] {ghostsOn ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (ghostsOn = !ghostsOn)}>frontier</button>{/if}
        </div>
      {/if}
      {/if}
    </div>

    <div class="absolute bottom-3 right-3 flex max-h-[44vh] w-[min(13rem,62vw)] flex-col overflow-hidden rounded-xl border border-[var(--hair)] bg-[var(--panel)] p-2.5 text-xs backdrop-blur">
      <button class="flex w-full flex-none items-center gap-1 font-mono text-[10px] uppercase text-[var(--faint)] hover:text-[var(--ink)] {legendOpen ? 'mb-1.5' : ''}" onclick={() => (legendOpen = !legendOpen)} aria-expanded={legendOpen} aria-label="{legendOpen ? 'collapse' : 'expand'} legend">
        <span class="text-[9px]">{legendOpen ? "▾" : "▸"}</span>
        <span class="truncate">{#if color === "region"}{curCount} regions{#if legendOpen}<span class="normal-case text-[var(--faint)]"> · click to isolate</span>{/if}{:else if colorDim?.kind === "categorical"}{colorDim.name} · {colorDim.ord?.length}{#if legendOpen}<span class="normal-case text-[var(--faint)]"> · click to isolate</span>{/if}{:else if colorDim}{colorDim.name}{#if colorDim.variance != null}<span class="normal-case text-[var(--faint)]"> · {Math.round(colorDim.variance * 100)}% variance{colorDim.weak ? " (thin)" : ""}</span>{/if}{:else}legend{/if}</span>
      </button>
      {#if legendOpen}
        <div class="min-h-0 overflow-auto">
        {#if color === "region"}
          {#each curClusters as c}<div class="flex cursor-pointer items-center gap-2 py-1.5 hover:text-[var(--ink)] {pinned === c.c ? 'text-[var(--ink)] font-semibold' : ''}" role="button" tabindex="0" aria-label="isolate region {c.label}" aria-pressed={pinned === c.c} onmouseenter={() => { if (pinned === null) handle?.setHighlight(c.c); }} onmouseleave={() => { if (pinned === null) handle?.setHighlight(null); }} onclick={() => togglePin(c.c)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(c.c); } }}><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(c.c))}"></span><span class="truncate" title={c.label}>{c.label} <span class="text-[var(--faint)]">{c.n}</span></span></div>{/each}
        {:else if colorDim?.kind === "categorical"}
          {#each colorDim.ord!.slice(0, 16) as v}<div class="flex cursor-pointer items-center gap-2 py-1.5 hover:text-[var(--ink)] {facetPin === v ? 'text-[var(--ink)] font-semibold' : ''}" role="button" tabindex="0" aria-label="isolate {colorDim.name} {v}" aria-pressed={facetPin === v} onclick={() => toggleFacetPin(v)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFacetPin(v); } }}><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(colorDim.idx![v]))}"></span><span class="truncate" title={v}>{v} <span class="text-[var(--faint)]">{colorDim.cnt![v]}</span></span></div>{/each}
          {#if colorDim.ord!.length > 16}<div class="text-[var(--faint)]">+{colorDim.ord!.length - 16} more</div>{/if}
        {:else if colorDim}
          {@const cp = poles(colorDim)}
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(0))}"></span>{cp[0]}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(1))}"></span>{cp[1]}</div>
        {/if}
        </div>
      {/if}
    </div>

    <div class="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 whitespace-nowrap font-mono text-[11px] text-[var(--faint)] sm:block">{hint}</div>
    {#if selected === null && !deckOpen}
      <div class="pointer-events-none absolute bottom-3 right-56 hidden font-mono text-[10px] text-[var(--faint)] min-[980px]:block">{data.ids.length} cards · {layout} · {sizeLabel}</div>
    {/if}
  {/if}

  <!-- hover tooltip: a corpus card, or a frontier ghost paper (distinct content, not a mislabeled card) -->
  {#if hovered && data && selected === null}
    <div class="pointer-events-none absolute z-10 max-w-xs rounded-lg border border-[var(--hair)] bg-[var(--panel)] p-2.5 text-xs shadow-xl backdrop-blur" style="left:{Math.min(hovered.x + 14, window.innerWidth - 280)}px; top:{Math.min(hovered.y + 14, window.innerHeight - 120)}px">
      {#if hovered.kind === "point"}
        <div class="mb-1 flex items-center gap-1.5 font-mono text-[10px] text-[var(--faint)]"><span class="h-2 w-2 flex-none rounded-sm" style="background:{rgb(col(assignment[hovered.i]))}"></span><span class="truncate">{regionOf(hovered.i)}</span></div>
        <div class="mb-1 font-bold leading-snug">{data.titles[hovered.i]}</div>
        <div class="line-clamp-2 text-[var(--dim)]">{data.cores[hovered.i].slice(0, 140)}</div>
      {:else}
        <div class="mb-1 font-bold">{hovered.g.title}</div>
        <div class="font-mono text-[10px] text-[var(--faint)]">frontier paper · cited {hovered.g.n}× in this corpus{hovered.g.arxiv ? " · arXiv:" + hovered.g.arxiv : ""}</div>
        <div class="mt-1 font-mono text-[10px] text-[var(--accent)]">click → open on arXiv ↗</div>
      {/if}
    </div>
  {/if}

  <!-- detail panel -->
  {#if selected !== null && data}
    <div use:trapFocus tabindex="-1" role="dialog" aria-label="card detail" class="absolute bottom-3 left-3 right-3 max-h-[64vh] overflow-auto rounded-xl border border-[var(--hair)] bg-[var(--panel)] p-4 text-sm backdrop-blur sm:right-auto sm:w-80">
      <button class="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-md font-mono text-base text-[var(--faint)] hover:bg-[var(--chip)] hover:text-[var(--soft)]" onclick={() => requestClose()} aria-label="close">✕</button>
      <div class="mb-1 pr-6 font-bold">{data.titles[selected]}</div>
      <div class="mb-2 font-mono text-[10px] text-[var(--faint)]">{[data.authors?.[selected], dateOf(selected), regionOf(selected)].filter(Boolean).join(" · ")}</div>
      <div class="mb-2 flex flex-wrap gap-3">
        {#if data.urls?.[selected]}<a class="inline-block font-mono text-xs font-bold text-[var(--accent)] hover:underline" href={data.urls[selected]} target="_blank" rel="noopener">{readerLabel(data.urls[selected])} →</a>{/if}
        {#if data.sources?.[selected]}<a class="inline-block font-mono text-xs font-bold text-[var(--accent)] hover:underline" href={data.sources[selected]} target="_blank" rel="noopener">{sourceLabel(selected)} →</a>{/if}
      </div>
      <div class="mb-1 text-xs leading-relaxed text-[var(--soft)]">{data.cores[selected].slice(0, 420)}{data.cores[selected].length > 420 ? "…" : ""}</div>

      <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide text-[var(--faint)]">where it sits</div>
      {#each placements(selected) as p}
        <div class="flex items-center justify-between gap-2 border-b border-[var(--hair)] py-1 text-xs" title={(p.s >= 50 ? p.a.high : p.a.low) + " — " + p.note}>
          <span class="truncate text-[var(--dim)]">{p.a.name}</span>
          <span class="flex-none font-mono text-[10px]">{p.s >= 50 ? "▲" : "▼"} <b>{p.s}</b></span>
        </div>
      {/each}

      <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide text-[var(--faint)]">nearest {data.nbr[selected]?.length ?? 0}</div>
      {#each data.nbr[selected] ?? [] as j}
        <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--chip)]" onclick={() => focusCard(j)}>→ {data.titles[j]}</button>
      {/each}
    </div>
  {/if}

  <!-- deck / list view — the accessible, sortable/filterable reader (real DOM, keyboard-navigable) -->
  {#if deckOpen && data}
    <div use:trapFocus tabindex="-1" role="dialog" aria-label="deck reader" class="absolute inset-x-2 top-2 bottom-2 z-30 mx-auto flex max-w-4xl flex-col rounded-xl border border-[var(--hair)] bg-[var(--panel-solid)] p-3 backdrop-blur">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <b class="text-sm">Deck</b>
        <span class="font-mono text-[10px] text-[var(--faint)]">{deckList.length} cards</span>
        <label class="flex items-center gap-1 text-xs"><span class="font-mono text-[10px] text-[var(--faint)]">sort</span>
          <select bind:value={deckSort} class="rounded-md border border-[var(--hair2)] bg-[var(--card)] px-1.5 py-1 text-xs">
            {#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}
          </select></label>
        {#if hasRead}<button class="rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] {deckUnread ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (deckUnread = !deckUnread)}>unread only</button>{/if}
        <input bind:value={deckQ} placeholder="filter…" class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--card)] px-2 py-1 text-xs" />
        <button class="ml-auto grid h-10 w-10 flex-none place-items-center rounded-md border border-[var(--hair2)] font-mono text-base text-[var(--faint)] hover:bg-[var(--chip)] hover:text-[var(--ink)]" onclick={() => requestClose()} aria-label="close deck">✕</button>
      </div>
      <div class="grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
        {#if deckList.length === 0}<div class="col-span-full py-16 text-center font-mono text-xs text-[var(--faint)]">no cards match “{deckQ}”{deckUnread ? " (unread only)" : ""}</div>{/if}
        {#each deckList as i (i)}
          <button class="rounded-lg border border-[var(--hair)] bg-[var(--card)] p-2.5 text-left hover:border-[var(--hair2)] {data.read?.[i] === true ? 'opacity-60' : ''}" onclick={() => { focusCard(i); deckOpen = false; }}>
            <div class="flex items-start justify-between gap-2">
              <div class="truncate text-[13px] font-bold">{data.titles[i]}</div>
              {#if data.sources?.[i] || data.urls?.[i]}<a href={data.sources?.[i] || data.urls?.[i]} target="_blank" rel="noopener" class="flex-none font-mono text-[10px] font-bold text-[var(--accent)] hover:underline" onclick={(e) => e.stopPropagation()}>open →</a>{/if}
            </div>
            <div class="my-1 line-clamp-2 text-[11px] text-[var(--dim)]">{data.cores[i].slice(0, 160)}</div>
            <div class="flex flex-wrap gap-1">
              <span class="rounded-full bg-[var(--chip)] px-2 py-0.5 font-mono text-[9px] text-[var(--soft)]">◆ {regionOf(i)}</span>
              {#each topAxes(i) as t}<span class="rounded-full bg-[var(--chip2)] px-2 py-0.5 font-mono text-[9px] text-[var(--dim)]">{axShort(t.n)} {t.s}</span>{/each}
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- first-run intro (remembered in localStorage) -->
  {#if showIntro && data}
    <div class="absolute inset-0 z-40 grid place-items-center bg-[var(--scrim)] p-4 backdrop-blur-sm">
      <div use:trapFocus tabindex="-1" role="dialog" aria-modal="true" aria-label="welcome" class="max-w-md rounded-2xl border border-[var(--hair)] bg-[var(--panel-solid)] p-6 shadow-2xl">
        <div class="text-lg font-bold">{prov?.title ?? "the forms of the corpus"} 🔭</div>
        <div class="mt-1 font-mono text-[11px] text-[var(--faint)]">{data.ids.length} documents · {data.axes.length} discovered axes · {data.k} regions{#if prov?.generated} · {provDate(prov.generated)}{/if}</div>
        {#if prov?.source}<div class="mt-0.5 truncate font-mono text-[10px] text-[var(--faint)]">from {prov.source}</div>{/if}
        <ul class="mt-3 space-y-2 text-sm text-[var(--dim)]">
          <li><b class="text-[var(--ink)]">Proximity is similarity</b> — nearby cards are alike; colour is an emergent region, size is influence.</li>
          <li><b class="text-[var(--ink)]">Slide the grain</b> to move regions from continents to towns; click a region to isolate, double-click the map to drill in.</li>
          <li><b class="text-[var(--ink)]">Tap any card</b> to read it, see its nearest neighbours, and open the source.</li>
          <li><b class="text-[var(--ink)]">Open the deck</b> to read the corpus as a sortable, filterable list — or switch layout to axis scatter.</li>
        </ul>
        <button class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)] hover:opacity-90" onclick={dismissIntro}>explore →</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* theme svelte-range-slider-pips (the dual-thumb scrubber) to the app tokens — one battle-tested widget
     replaces the hand-rolled two-overlapping-inputs + pointer-events hack. :global reaches its scoped nodes. */
  .scrub :global(.rangeSlider) { margin: 4px 2px; height: 5px; background: var(--chip2); --range-handle-inactive: var(--accent); --range-handle: var(--accent); --range-handle-focus: var(--accent); --range-range: var(--accent); }
  .scrub :global(.rangeSlider .rangeHandle .rangeNub) { box-shadow: 0 0 0 1px var(--panel); }
</style>
