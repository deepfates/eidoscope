<script lang="ts">
  import { onMount, untrack } from "svelte";
  import RangeSlider from "svelte-range-slider-pips";
  import { DropdownMenu, Popover } from "bits-ui";
  import { loadMap, mapUrl, decodeEido } from "./loader";
  import { createMap, type MapHandle } from "./deckmap";
  import { col, axisColor, setActiveTheme } from "./encode";
  import { themePalette } from "./palette";
  import { buildDimensions, scores01, type Dimension } from "./dimensions";
  import { ViewModel, parseUrl, type CameraOp } from "./model.svelte";
  import { embedQuery, cosineAll, resetEmbedder } from "./semantic";
  import type { MapContract } from "../../src/schema";

  // THE MODEL — channels, filters, scrubber, the dimension registry, URL (de)serialization. App keeps the DOM,
  // the deck handle, the camera and the browser APIs; it reads the model and hands it user intent.
  const m = new ViewModel();

  let canvas: HTMLCanvasElement;
  let mapBox = $state<HTMLElement | null>(null);   // the map's own box (toolbar sits above it now)
  let status = $state("loading your map…");
  let loadFailed = $state(false);
  let hovered = $state<{ kind: "point"; i: number; x: number; y: number } | { kind: "ghost"; g: any; x: number; y: number } | null>(null);
  let handle = $state<MapHandle | null>(null);
  let showLabels = $state(true);
  let deckOpen = $state(false);
  let deckQ = $state("");
  let deckUnread = $state(false);
  let semQuery = $state("");                 // the query-box text (distinct from m.query, the substring find)
  let querying = $state(false);
  let queryErr = $state("");
  let queryStatus = $state("");   // live line while the first query downloads the model / embeds
  let queryPct = $state<number | null>(null);   // download % when known (drives the thin progress bar)
  let showIntro = $state(false);
  let citeOn = $state(false);
  let ghostsOn = $state(false);
  let sheetOpen = $state(false);   // mobile: the toolbar's contents as a bottom sheet

  // ── THEMES ────────────────────────────────────────────────────────────────────────────────────────
  // "Theme your own reader": a curated set of DaisyUI themes, stamped on <html data-theme>. The map now
  // READS those tokens (palette.ts): its categorical colours, its ink and its notion of a dark ground all
  // come from the live theme, so chrome and canvas are one colour system. `mode` survives only as the
  // ☾/☀ toggle's hint about which default to flip to — the map never consults it.
  const THEMES = [
    { id: "black", label: "black", mode: "dark" as const },
    { id: "light", label: "light", mode: "light" as const },
    { id: "dim", label: "dim", mode: "dark" as const },
    { id: "night", label: "night", mode: "dark" as const },
    { id: "nord", label: "nord", mode: "dark" as const },
    { id: "sunset", label: "sunset", mode: "dark" as const },
    { id: "synthwave", label: "synthwave", mode: "dark" as const },
    { id: "retro", label: "retro", mode: "light" as const },
    { id: "corporate", label: "corporate", mode: "light" as const },
    { id: "winter", label: "winter", mode: "light" as const },
  ];
  const DEFAULT_DARK = "black", DEFAULT_LIGHT = "light";
  const modeOf = (id: string) => THEMES.find((t) => t.id === id)?.mode ?? "dark";
  let themeName = $state(DEFAULT_DARK);
  // The GROUND is read from the live theme's own base-100 lightness, not from a hardcoded per-theme flag
  // (that flag was wrong for themes DaisyUI has since re-tinted — nord is a light theme in v5). modeOf
  // survives only as the fallback for a theme whose tokens we couldn't parse.
  // ONE invalidation number for everything painted from the theme-derived palette. setTheme stamps
  // data-theme, then regenerates the palette from the freshly-computed tokens and bumps this; the legend
  // swatches ($derived on palVer) and the deck layers (Opts.theme → colorVer/themeVer) both re-read.
  let palVer = $state(0);
  const theme = $derived.by(() => { void palVer; return (themePalette(themeName)?.dark ?? modeOf(themeName) === "dark") ? "dark" : "light"; });
  const colOf = $derived.by(() => { void palVer; return (c: number) => col(c); });

  // read-only views onto the model, so the markup below reads as plainly as it did when the state was inline
  const data = $derived(m.data);
  const selected = $derived(m.selected);
  const pinned = $derived(m.pinned);
  const facetPin = $derived(m.facetPin);
  const allDims = $derived(m.allDims);
  const queryDims = $derived(m.queryDims);
  const colorDim = $derived(m.colorDim), xDim = $derived(m.xDim), yDim = $derived(m.yDim), zDim = $derived(m.zDim), sizeDim = $derived(m.sizeDim);
  const assignment = $derived(m.assignment);
  const curCount = $derived(m.curCount);
  const curClusters = $derived(m.curClusters);
  const nLevels = $derived(m.nLevels);
  const chips = $derived(m.chips);
  const filterMask = $derived(m.filterMask);
  const scrubFields = $derived(m.scrubFields), scrubField = $derived(m.scrubField), scrubRange = $derived(m.scrubRange);
  const propsOf = m.propsOf, poles = m.poles;
  const setProp = (d: Dimension, patch: Parameters<typeof m.setProp>[1]) => m.setProp(d, patch);
  const scalarDims = $derived(allDims.filter((d) => d.kind !== "categorical"));
  const catDims = $derived(allDims.filter((d) => d.kind === "categorical"));

  // Pin/isolate is a state mutation (model) plus a camera move (App owns the handle) — the model returns the
  // camera intent rather than reaching for a deck handle it has no business knowing about.
  function applyCamera(op: CameraOp) { if (op?.kind === "fit") handle?.fitToIndices(op.indices); else if (op?.kind === "reset") handle?.resetView(); }
  const togglePin = (c: number) => applyCamera(m.togglePin(c));
  const toggleFacetPin = (v: string) => applyCamera(m.toggleFacetPin(v));

  function setTheme(t: string, persist = true) {
    themeName = THEMES.some((x) => x.id === t) ? t : DEFAULT_DARK;
    document.documentElement.dataset.theme = themeName;
    setActiveTheme(themeName); palVer++;   // tokens are live now that data-theme is stamped
    if (persist) try { localStorage.setItem("eido-theme", themeName); } catch {}
  }
  // the ☾/☀ toggle flips GROUND, not a specific theme: a dark theme goes to the light default and back.
  function toggleTheme() { setTheme(theme === "dark" ? DEFAULT_LIGHT : DEFAULT_DARK); }
  const hasCite = $derived(!!data?.cite?.some((e) => e.length));
  const hasGhosts = $derived(!!data?.ghosts?.length);
  // history-synced overlays (eid-fktf): opening an overlay pushes a history entry, so Back — and the
  // mobile back gesture — closes the topmost one (the only intuitive way to escape deck/detail on a phone).
  let overlayPushed = false;
  function doCloseOverlays() { if (showIntro) { try { localStorage.setItem("eido-seen", "1"); } catch {} } showIntro = false; deckOpen = false; sheetOpen = false; if (selected !== null) focusCard(null); }
  function requestClose() { if (overlayPushed) { try { history.back(); return; } catch {} } doCloseOverlays(); }
  function dismissIntro() { requestClose(); }
  $effect(() => { const anyOpen = showIntro || deckOpen || sheetOpen || selected !== null; if (anyOpen && !overlayPushed) { try { history.pushState({ eido: 1 }, ""); } catch {} overlayPushed = true; } });
  const hasRead = $derived(!!data?.read?.some((r) => r === true || r === false));
  const axShort = (name: string) => name.split(/ vs\.? | and /i)[0].slice(0, 15);
  const deckList = $derived.by(() => {
    if (!data) return [] as number[];
    let list = data.ids.map((_, i) => i);
    const q = deckQ.trim().toLowerCase();
    if (q) list = list.filter((i) => data!.titles[i].toLowerCase().includes(q) || data!.cores[i].toLowerCase().includes(q));
    if (deckUnread && hasRead) list = list.filter((i) => data!.read![i] !== true);
    const sd = allDims.find((x) => x.key === m.channels.sort);   // sort by any scalar dimension (influence, length, axis, query…)
    const sv = sd && sd.kind !== "categorical" ? scores01(sd, propsOf(sd)) : null;
    if (sv) list.sort((a, b) => (sv[b] ?? 0) - (sv[a] ?? 0));
    return list.slice(0, 2000);  // show the whole corpus (was 300 — which hid most cards + masked "unread only")
  });
  const labelsOn = $derived(showLabels && m.channels.color === "region");  // 3D now has proper billboarded region labels (isomorphic with 2D)
  // switching the colour lens drops stale facet filters (a folder value means nothing under a different lens)
  let lastColorForFacet = m.channels.color;
  $effect(() => { const c = m.channels.color; if (c !== lastColorForFacet) { lastColorForFacet = c; const cur = untrack(() => m.colorDim?.key); untrack(() => m.dropStaleFacets(cur)); } });

  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const trunc = (s: string, m2 = 44) => (s && s.length > m2 ? s.slice(0, m2 - 1) + "…" : s);
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

  function focusCard(i: number | null) { m.selected = i; handle?.setFocus(i); }
  function reset() { focusCard(null); m.clearFilters(); handle?.setHighlight(null); m.grain = data?.di ?? 0; handle?.resetView(); }

  // The current label for each channel button — the toolbar states the view, so nothing is hidden in a menu.
  const LAYOUT_LABELS: Record<string, string> = { mde: "neighbor map", axes: "axis scatter", orbit: "3D neighbor map", axes3d: "3D axis scatter" };
  const colorLabel = $derived(m.channels.color === "region" ? "region" : colorDim?.name ?? "region");
  const sizeLabel = $derived(m.channels.size === "uniform" ? "uniform" : sizeDim?.name ?? "uniform");

  // deep-linkable view state (eid-yxqu): the URL always mirrors the current view, so any view — or a
  // specific card — is a shareable link and a reload restores it. replaceState (not push) so it doesn't
  // fight the overlay history (fktf); the ?map= param is preserved. The theme rides along additively (the
  // model owns view state, not chrome — App appends it), so a shared link carries the reader you styled.
  let urlReady = false;
  function currentUrl() {
    const u = m.serializeUrl(location.pathname, location.search);
    return themeName === DEFAULT_DARK ? u : u + (u.includes("?") ? "&" : "?") + "theme=" + encodeURIComponent(themeName);
  }
  // Restore: the model decodes + applies the eager half; App owns the DOM-ish half (slider remount, async
  // query embedding, and the grain-dependent region/facet/find/card, applied once the graph has settled).
  function applyUrlState() {
    const p = parseUrl(location.search);
    m.applyPatch(p);
    if (p.color) lastColorForFacet = p.color;   // keep the facet-clear effect from firing on this restore
    if (p.scrubbed) scrubNonce++;               // remount the slider so its thumbs show the restored window
    for (const t of p.queries) embedAndAdd(t);  // best-effort, background; won't block the restore or hang the app
    queueMicrotask(() => {
      if (p.region !== undefined && p.region >= 0 && p.region < curCount) togglePin(p.region);
      if (p.facet !== undefined && colorDim?.ord?.includes(p.facet)) toggleFacetPin(p.facet);
      if (p.find !== undefined) m.onFind(p.find);
      if (p.card !== undefined && data) { const i = data.ids.indexOf(p.card); if (i >= 0) focusCard(i); }
    });
  }
  $effect(() => { void [m.layout, m.channels.color, m.channels.size, m.grain, m.channels.x, m.channels.y, m.channels.z, m.pinned, m.selected, m.channels.scrub, m.scrubLo, m.scrubHi, m.dimProps, m.filters, m.queries, themeName]; if (urlReady) { try { history.replaceState(history.state, "", currentUrl()); } catch {} } });

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
  // the details sidebar is DOCKED, not modal — so it takes focus on open and hands it back on close, but it
  // deliberately does NOT trap: the toolbar stays operable while a card is open (that's the point of a pane).
  function focusOnOpen(node: HTMLElement) {
    const opener = document.activeElement as HTMLElement | null;
    queueMicrotask(() => { try { node.focus(); } catch {} });
    return { destroy() { try { opener?.focus(); } catch {} } };
  }

  // Bring a decoded map onto the canvas — used for the first load AND for opening a new file/url at runtime,
  // so the viewer is a general .eido opener, not welded to one bundled map. Tears down the old GPU context,
  // resets per-corpus selection, re-wires the createMap handle + the read-only __eido test seam.
  let dragOver = $state(false);
  function mountMap(D: MapContract, opts?: { intro?: boolean }) {
    handle?.destroy();                                   // free the previous deck's GPU context before recreating
    m.mount(D);                                          // per-corpus state reset + x/y/z parked on this file's axes
    status = "";
    if (opts?.intro) showIntro = true;                    // a freshly-opened file introduces itself
    const dims0 = buildDimensions(D);   // build the registry ONCE for this mount's accessors
    const ch = m.channels;
    handle = createMap(canvas, D, {
      getColor: m.colorGet(dims0, ch.color, D.levels?.[m.grain] ?? D.cluster), getRadius: m.sizeGet(dims0, ch.size), getX: m.posGet(dims0, ch.x), getY: m.posGet(dims0, ch.y), getZ: m.posGet(dims0, ch.z), posSig: m.posSig, layout: m.layout, showLabels: labelsOn, grain: m.grain, theme: themeName,
      onClick: (i) => focusCard(i < 0 ? null : i),
      onHover: (h, x, y) => (hovered = h == null ? null : { ...h, x, y }),
      onGrainChange: (g) => { m.grain = g; m.pinned = null; },
    });
    // read-only introspection seam for the integration suite (drives the REAL built app, asserts real state)
    (window as any).__eido = () => { const d = handle?.debug(); return { grain: m.grain, k: curCount, layout: m.layout, color: m.channels.color, pin: pinned, facetPin, focus: selected, detail: selected !== null, deckOpen, cite: citeOn, ghosts: ghostsOn, theme, themeName, pal: Array.from({ length: 6 }, (_, i) => col(i)), hover: hovered ? hovered.kind : null, zoom: d?.zoom ?? 0, labels: d?.labels ?? 0, labelsOn, regions: d?.regions ?? 0, rot: d?.rot ?? null, rotX: d?.rotX ?? null, target: d?.target ?? null, span3: d?.span3 ?? null, filters: chips.map((c) => c.label), visible: filterMask ? filterMask.reduce((a, v) => a + v, 0) : (data?.ids.length ?? 0) }; };
    // the map no longer fills the window (a toolbar sits above it), so both seams speak PAGE coordinates —
    // what a test's mouse/touch actually uses — and convert at the canvas edge.
    const rect = () => canvas.getBoundingClientRect();
    (window as any).__eidoProject = (xy: number[]) => { const p = handle?.project(xy); if (!p) return p; const r = rect(); return [p[0] + r.left, p[1] + r.top]; };
    (window as any).__eidoPick = (x: number, y: number) => { const r = rect(); return handle?.pickAt(x - r.left, y - r.top); };
  }
  // Semantic query: embed in-browser (same model that made the card vectors), cosine-rank, and append a
  // query-kind DIMENSION. It then appears in every channel menu (color/size/x/y/z/scrubber/deck-sort) like any
  // other dimension — no bespoke plumbing. N queries coexist. To hide low-similarity cards, put the query on the scrubber.
  // embed a text query → append a query-kind dimension; returns its key (or null). It does NOT touch any channel:
  // making an axis and placing it are separate acts (the user decides where it goes), so nothing moves underneath.
  async function embedAndAdd(q: string): Promise<string | null> {
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
      const key = m.addQuery(q, cosineAll(qv, D.vectors));
      queryStatus = "";
      return key;
    } catch (e: any) {
      resetEmbedder();   // drop the poisoned/half-loaded model so the next add retries cleanly
      queryErr = e?.message === "__stall__"
        ? "model download stalled — check your connection, then press add to retry"
        : "couldn’t run the query (" + String(e?.message ?? e) + ") — press add to retry";
      queryStatus = "";
      return null;
    } finally { clearTimeout(stallTimer); querying = false; }
  }
  async function runQuery() { const q = semQuery.trim(); if (!q) return; semQuery = ""; await embedAndAdd(q); }
  async function openFile(file: File) {
    try {
      status = "opening " + file.name + "…"; loadFailed = false;
      mountMap(await decodeEido(new Uint8Array(await file.arrayBuffer())), { intro: true });
    } catch (e: any) { loadFailed = true; status = "couldn't open " + file.name + " — " + (e?.message ?? e); }
  }
  function onDrop(e: DragEvent) { e.preventDefault(); dragOver = false; const f = e.dataTransfer?.files?.[0]; if (f && /\.eido$/i.test(f.name)) openFile(f); }

  onMount(() => {
    try {
      const fromUrl = new URLSearchParams(location.search).get("theme");
      const saved = localStorage.getItem("eido-theme");
      // legacy values: the toggle used to persist the literal ground, not a theme id.
      const legacy = saved === "dark" ? DEFAULT_DARK : saved === "light" ? DEFAULT_LIGHT : saved;
      if (fromUrl && THEMES.some((t) => t.id === fromUrl)) setTheme(fromUrl, false);
      else if (legacy && THEMES.some((t) => t.id === legacy)) setTheme(legacy, false);
      else setTheme(matchMedia("(prefers-color-scheme: light)").matches ? DEFAULT_LIGHT : DEFAULT_DARK, false);
    } catch { setTheme(DEFAULT_DARK, false); }
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
    // Escape closes the topmost OVERLAY — but a toolbar menu is not an overlay: Bits UI already closes it on
    // Escape, and letting the same key also pop history would yank the view out from under a menu dismissal.
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; if (document.querySelector('[data-menu][data-state="open"]')) return; requestClose(); };
    const onPop = () => { overlayPushed = false; doCloseOverlays(); };  // Back / mobile back gesture closes the overlay
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => { handle?.destroy(); window.removeEventListener("keydown", onKey); window.removeEventListener("popstate", onPop); };
  });

  $effect(() => {
    const l = m.layout, c = m.channels.color, s = m.channels.size, xk = m.channels.x, yk = m.channels.y, zk = m.channels.z, sl = labelsOn, g = m.grain, a = assignment, co = citeOn, go = ghostsOn, th = themeName, h = handle, d = data, ad = allDims, dp = m.dimProps, ps = m.posSig;
    void dp; // dimProps in deps so a norm/invert change re-pushes the accessors
    if (h && d) h.update({ getColor: m.colorGet(ad, c, a), getRadius: m.sizeGet(ad, s), getX: m.posGet(ad, xk), getY: m.posGet(ad, yk), getZ: m.posGet(ad, zk), posSig: ps, layout: l, showLabels: sl, grain: g, citeOn: co, ghostsOn: go, theme: th });
  });

  // SCRUBBER (channel grammar): ONE slider that reveals cards cumulatively along ANY scalar/temporal field —
  // date, length, influence, citation impact, or a discovered axis — chosen from the dimension registry, via
  // deck's GPU DataFilterExtension. The window itself lives in the model; only the remount hack lives here:
  // svelte-range-slider-pips mutates its `values` array in place, which Svelte 5's bind-bridge doesn't write
  // back — so bind:values can't capture drags. Instead the slider is one-way (values from m.scrubLo/Hi) with an
  // on:change writer, and this nonce force-REMOUNTS it on any external reset so the thumbs re-read fresh state.
  let scrubNonce = $state(0);
  m.onScrubReset = () => scrubNonce++;
  const resetScrub = () => m.resetScrub();
  const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  // adaptive numeric label: more decimals for small-span axes so a cosine/PCA range (~[-0.5,0.5]) doesn't
  // collapse to "0 – 0" while a length axis (~[100,2300]) doesn't show noise decimals.
  const fmtNum = (v: number, span: number) => { const a = Math.abs(span); return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3); };
  const scrubText = $derived.by(() => {
    const r = scrubRange, f = scrubField; if (!r || !f) return "";
    return f.kind === "temporal"
      ? fmtDate(m.scrubLo ?? r[0]) + " – " + fmtDate(m.scrubHi ?? r[1])
      : fmtNum(m.scrubLo ?? r[0], r[1] - r[0]) + " – " + fmtNum(m.scrubHi ?? r[1], r[1] - r[0]);
  });
  $effect(() => { m.ensureScrubKey(); });
  $effect(() => { const h = handle, mask = filterMask; if (h) h.setFilterMask(mask); });  // push the mask (pure derived → no write-loop)

  const prov = $derived(data?.provenance);   // so a passed-around file introduces itself
  const provDate = (g?: number) => (g ? new Date(g).toISOString().slice(0, 10) : "");
  $effect(() => { try { document.title = prov?.title ? `${prov.title} · eidoscope 🔭` : "eidoscope 🔭"; } catch {} });
  const weakAxes = $derived(m.layout === "axes" ? (xDim?.weak ? 1 : 0) + (yDim?.weak ? 1 : 0) : 0);

  // ── ABOUT THIS MAP — projection as HYPOTHESIS, not ground truth ─────────────────────────────────────
  // Everything here is already in the .eido (derivedBy + the axis stats); the popover just says it out loud,
  // in the terms a reader needs to judge what the picture can and can't support. No new data, no new state.
  const madeBy = $derived(data?.derivedBy);
  const axStats = $derived.by(() => {
    const A = data?.axes ?? [];
    return { n: A.length, variance: A.reduce((s, a) => s + (a.variance ?? 0), 0), weak: A.filter((a) => a.weak).length };
  });
  // The two geometries have DIFFERENT bases and mean different things — the single most misread thing about
  // the map, so it's stated first and plainly.
  const positionsLine = $derived(madeBy?.geometryBasis === "raw"
    ? "UMAP of raw full-text embeddings — the card bottleneck was bypassed for this map (--embed raw)"
    : "UMAP of the card vectors — nearby means similar cards");
  // the region the legend has isolated — the sidebar reads it when no card is selected
  const pinnedRegion = $derived(pinned === null ? null : curClusters.find((c) => c.c === pinned) ?? null);
  const pinnedBlurb = $derived(pinned === null ? "" : data?.levelBlurbs?.[m.grain]?.[pinned] ?? "");
  const sidebarOpen = $derived(!!data && (selected !== null || pinnedRegion !== null));
</script>

{#snippet propItems(d: Dimension | undefined)}
  {#if d && (d.kind === "scalar" || d.kind === "temporal")}
    {@const p = propsOf(d)}
    <li class="menu-title text-[10px] tracking-widest uppercase">scale</li>
    <!-- discovered axes are rank-normalized positions by design (even, readable spread); norm isn't a
         user choice there, so only metrics/queries get the honest⇄rank toggle. invert applies to all. -->
    {#if !d.fixedNorm}
      <li><button onclick={() => setProp(d, { norm: "honest" })} aria-label="honest magnitudes" aria-pressed={p.norm === "honest"} title="scale {d.name} by its true magnitudes — the skew shows"><span class="w-3">{p.norm === "honest" ? "✓" : ""}</span> honest magnitudes <span class="ml-auto text-xs opacity-50">the skew shows</span></button></li>
      <li><button onclick={() => setProp(d, { norm: "rank" })} aria-label="rank-normalized" aria-pressed={p.norm === "rank"} title="spread {d.name} evenly by rank order"><span class="w-3">{p.norm === "rank" ? "✓" : ""}</span> rank-normalized <span class="ml-auto text-xs opacity-50">even spread</span></button></li>
    {/if}
    <li><button onclick={() => setProp(d, { invert: !p.invert })} aria-label="invert direction" aria-pressed={p.invert} title="flip {d.name}: high ↔ low"><span class="w-3">{p.invert ? "✓" : ""}</span> invert direction <span class="ml-auto text-xs opacity-50">high ↔ low</span></button></li>
  {/if}
{/snippet}

<!-- one row of the colour legend, doubling as the isolate control (the legend IS the picker) -->
{#snippet legendRow(swatch: string, label: string, count: number | undefined, active: boolean, aria: string, act: () => void, enter?: () => void, leave?: () => void)}
  <li>
    <button aria-label={aria} aria-pressed={active} class="gap-2 {active ? 'menu-active font-semibold' : ''}" onclick={act} onmouseenter={enter} onmouseleave={leave}>
      <span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{swatch}"></span>
      <span class="truncate" title={label}>{label}</span>
      {#if count !== undefined}<span class="ml-auto flex-none font-mono text-[10px] opacity-60">{count}</span>{/if}
      <!-- the verb, said out loud: the row IS the isolate control, so on hover/focus it names itself.
           `aria-hidden` because the button's aria-label already carries "isolate <thing>". -->
      <span aria-hidden="true" class="isolate-cue ml-auto flex-none font-mono text-[10px] opacity-0">{active ? "release" : "isolate"}</span>
    </button>
  </li>
{/snippet}

<!-- ABOUT THIS MAP — the corpus name IS the button. Says how the picture was made (from the .eido's own
     derivedBy + axis stats) so a reader can weigh it as a hypothesis rather than read it as a fact. -->
{#snippet about(scope: string)}
  {#if data}
    <Popover.Root>
      <Popover.Trigger class="rounded-field min-w-0 cursor-pointer px-1 py-0.5 text-left hover:bg-base-300" data-menu="{scope}:about"
        aria-label="about this map — how it was made" title="about this map — how it was made">
        <div class="truncate text-sm font-bold leading-tight">{prov?.title ?? "eidoscope"}</div>
        <div class="truncate font-mono text-[10px] leading-tight opacity-60">{data.ids.length} cards · {curCount} regions · about ⓘ</div>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop thin-sb max-h-[min(32rem,80vh)] w-88 overflow-y-auto p-3" sideOffset={6} align="start" data-about>
          <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">about this map</div>
          <div class="text-sm font-bold leading-snug">{prov?.title ?? "eidoscope"}</div>
          <div class="mt-0.5 font-mono text-[10px] leading-snug opacity-60">
            {data.ids.length} documents · {axStats.n} discovered axes · {curCount} regions{#if prov?.generated} · {provDate(prov.generated)}{/if}</div>
          {#if prov?.source}<div class="mt-0.5 break-all font-mono text-[10px] opacity-60"><span class="uppercase tracking-widest opacity-70">corpus source</span> {prov.source}</div>{/if}

          <div class="mt-3 space-y-2 text-[11px] leading-snug">
            <div><span class="font-bold">positions</span> — <span class="opacity-75">{positionsLine}. Distance is relative, not a measured quantity; there are no units.</span></div>
            <div><span class="font-bold">axes</span> — <span class="opacity-75">PCA of the full-text embeddings. A card's place on an axis is its exact projection, so an axis position IS a number you can compare.</span></div>
            <div><span class="font-bold">regions</span> — <span class="opacity-75">clusters of the same vectors, named by a model from what each group over-uses. The grain slider picks how finely the corpus is cut.</span></div>
          </div>

          <div class="mt-3 border-t border-base-300 pt-2">
            <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">strength</div>
            <div class="text-[11px] leading-snug opacity-75">
              The {axStats.n} axes together explain <b class="opacity-100">{Math.round(axStats.variance * 100)}%</b> of the variation between documents{#if axStats.weak}, and <b class="opacity-100">{axStats.weak}</b> of them {axStats.weak > 1 ? "are" : "is"} thin (under 2% each) — read positions on those loosely{/if}. The rest is structure no straight axis captured.
            </div>
          </div>

          <div class="mt-3 border-t border-base-300 pt-2">
            <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">made by</div>
            <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px] opacity-70">
              {#if madeBy?.cardModel}<dt class="opacity-60">card model</dt><dd class="break-all">{madeBy.cardModel}</dd>{/if}
              {#if madeBy?.embedder}<dt class="opacity-60">embedder</dt><dd class="break-all">{madeBy.embedder.id} · {madeBy.embedder.dim}d</dd>{/if}
              {#if madeBy?.geometryBasis}<dt class="opacity-60">geometry</dt><dd>{madeBy.geometryBasis === "card" ? "card vectors (concept bottleneck)" : "raw full text"}</dd>{/if}
              {#if madeBy?.pipelineVersion}<dt class="opacity-60">pipeline</dt><dd>{madeBy.pipelineVersion}</dd>{/if}
              {#if madeBy?.generated}<dt class="opacity-60">generated</dt><dd>{provDate(madeBy.generated)}</dd>{/if}
              {#if !madeBy}<dt class="opacity-60">provenance</dt><dd>not recorded (pre-v2 file)</dd>{/if}
            </dl>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
{/snippet}

{#snippet controls(scope: string)}
  <!-- LAYOUT — plus the two map-render overlays, which are layout-ish rather than encoding-ish -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:layout" aria-label="layout">
      <span class="opacity-60">layout</span><span class="max-w-[9rem] truncate font-medium">{LAYOUT_LABELS[m.layout]}</span><span class="text-[9px] opacity-50">▾</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="eido-pop menu w-56 p-1" sideOffset={6} align="start">
        {#each Object.entries(LAYOUT_LABELS) as [k, name]}
          <DropdownMenu.Item role="menuitemradio" aria-checked={m.layout === k} class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:layout:{k}" onSelect={() => (m.layout = k as any)}>
            <span class="w-3">{m.layout === k ? "✓" : ""}</span>{name}
          </DropdownMenu.Item>
        {/each}
        {#if hasCite || hasGhosts}
          <DropdownMenu.Separator class="my-1 h-px bg-base-300" />
          {#if hasCite}<DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:overlay:cite" role="menuitemcheckbox" aria-checked={citeOn} title="draw an edge between citing and cited cards" onSelect={() => (citeOn = !citeOn)}><span class="w-3">{citeOn ? "✓" : ""}</span>cite edges</DropdownMenu.Item>{/if}
          {#if hasGhosts}<DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:overlay:ghosts" role="menuitemcheckbox" aria-checked={ghostsOn} title="show cited-but-absent papers at the edge of the corpus" onSelect={() => (ghostsOn = !ghostsOn)}><span class="w-3">{ghostsOn ? "✓" : ""}</span>frontier</DropdownMenu.Item>{/if}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>

  <!-- AXES — only meaningful in the scatter layouts; x/y/z with each dimension's own scale controls -->
  {#if m.layout === "axes" || m.layout === "axes3d"}
    <Popover.Root>
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:axes" aria-label="axes">
        <span class="opacity-60">axes</span><span class="max-w-[10rem] truncate font-medium">{xDim?.name ?? "—"} × {yDim?.name ?? "—"}</span><span class="text-[9px] opacity-50">▾</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="start">
          {#each [{ ch: "x" as const, d: xDim }, { ch: "y" as const, d: yDim }, ...(m.layout === "axes3d" ? [{ ch: "z" as const, d: zDim }] : [])] as ax}
            <div class="mb-2">
              <div class="mb-1 flex items-center gap-2">
                <span class="w-4 flex-none font-mono text-[10px] uppercase opacity-60">{ax.ch}</span>
                <select bind:value={m.channels[ax.ch]} data-axis={scope + ":" + ax.ch} aria-label="{ax.ch} axis" class="select select-xs min-w-0 flex-1">
                  {#each scalarDims as d}<option value={d.key}>{d.name}</option>{/each}
                </select>
              </div>
              {#if ax.d && !ax.d.fixedNorm}
                {@const p = propsOf(ax.d)}
                <div class="ml-6 flex gap-1">
                  <button class="btn btn-xs {p.norm === 'honest' ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.norm === "honest"} aria-label="{ax.ch} axis: honest magnitudes" title="true magnitudes — the skew shows" onclick={() => setProp(ax.d!, { norm: "honest" })}>honest</button>
                  <button class="btn btn-xs {p.norm === 'rank' ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.norm === "rank"} aria-label="{ax.ch} axis: rank-normalized" title="even spread by rank order" onclick={() => setProp(ax.d!, { norm: "rank" })}>rank</button>
                  <button class="btn btn-xs {p.invert ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.invert} aria-label="{ax.ch} axis: invert direction" title="flip the axis: high ↔ low" onclick={() => setProp(ax.d!, { invert: !p.invert })}>invert</button>
                </div>
              {:else if ax.d}
                {@const p = propsOf(ax.d)}
                <div class="ml-6 flex gap-1"><button class="btn btn-xs {p.invert ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.invert} aria-label="{ax.ch} axis: invert direction" title="flip the axis: high ↔ low" onclick={() => setProp(ax.d!, { invert: !p.invert })}>invert</button></div>
              {/if}
            </div>
          {/each}
          {#if weakAxes}<div class="rounded-field bg-base-200 px-2 py-1 text-[11px] leading-snug opacity-70">~ {weakAxes > 1 ? "minor axes" : "a minor axis"} (under 2% variance) — position is thin, read it loosely</div>{/if}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}

  <!-- COLOR — the picker AND the legend in one surface: what the colours mean, clickable to isolate,
       above the divider; the other lenses below it; the lens's own scale controls at the bottom. -->
  <Popover.Root>
    <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:color" aria-label="color">
      <span class="opacity-60">color</span>
      <span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{m.channels.color === 'region' ? rgb(colOf(0)) : colorDim?.kind === 'categorical' ? rgb(colOf(0)) : rgb(axisColor(1))}"></span>
      <span class="max-w-[9rem] truncate font-medium">{colorLabel}</span><span class="text-[9px] opacity-50">▾</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="eido-pop flex max-h-[min(34rem,80vh)] w-72 flex-col p-0" sideOffset={6} align="start">
        <div class="flex-none px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">
          {#if m.channels.color === "region"}{curCount} regions
          {:else if colorDim?.kind === "categorical"}{colorDim.name} · {colorDim.ord?.length}
          {:else if colorDim}{colorDim.name}{#if colorDim.variance != null}<span class="normal-case"> · {Math.round(colorDim.variance * 100)}% variance{colorDim.weak ? " (thin)" : ""}</span>{/if}
          {:else}legend{/if}
        </div>
        <ul class="menu thin-sb menu-sm min-h-0 w-full flex-1 flex-nowrap overflow-y-auto p-1 pt-0">
          {#if m.channels.color === "region"}
            {#each curClusters as c}
              {@render legendRow(rgb(colOf(c.c)), c.label, c.n, pinned === c.c, "isolate region " + c.label, () => togglePin(c.c), () => { if (pinned === null) handle?.setHighlight(c.c); }, () => { if (pinned === null) handle?.setHighlight(null); })}
            {/each}
          {:else if colorDim?.kind === "categorical"}
            {#each colorDim.ord!.slice(0, 16) as v}
              {@render legendRow(rgb(colOf(colorDim.idx![v])), v, colorDim.cnt![v], facetPin === v, "isolate " + colorDim.name + " " + v, () => toggleFacetPin(v))}
            {/each}
            {#if colorDim.ord!.length > 16}<li class="px-3 py-1 text-xs opacity-60">+{colorDim.ord!.length - 16} more</li>{/if}
          {:else if colorDim}
            {@const cp = poles(colorDim)}
            <li class="flex flex-row items-center gap-2 px-3 py-1 text-sm"><span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{rgb(axisColor(0))}"></span><span class="truncate">{cp[0]}</span></li>
            <li class="flex flex-row items-center gap-2 px-3 py-1 text-sm"><span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{rgb(axisColor(1))}"></span><span class="truncate">{cp[1]}</span></li>
          {/if}
        </ul>
        {#if m.channels.color === "region" && nLevels > 1}
          <!-- grain modifies the region clustering, so it belongs with the region legend -->
          <label class="flex flex-none items-center gap-2 border-t border-base-300 px-3 py-2 text-xs">
            <span class="flex-none font-mono text-[10px] uppercase opacity-60">grain</span>
            <input type="range" data-testid="grain" min="0" max={nLevels - 1} bind:value={m.grain} oninput={() => (m.pinned = null)} class="range range-xs min-w-0 flex-1" aria-label="grain level: how finely the map is divided into regions" aria-valuetext="{curCount} regions" />
            <span class="w-6 flex-none text-right font-mono text-[10px] opacity-60">{curCount}</span>
          </label>
        {/if}
        <div class="thin-sb max-h-56 flex-none overflow-y-auto border-t border-base-300">
          <ul class="menu menu-sm w-full p-1">
            <li class="menu-title text-[10px] tracking-widest uppercase">color by</li>
            <li><button data-opt="{scope}:color:region" aria-pressed={m.channels.color === "region"} title="colour by the region clustering at the current grain" onclick={() => (m.channels.color = "region")}><span class="w-3">{m.channels.color === "region" ? "✓" : ""}</span>region</button></li>
            {#each catDims as d}<li><button data-opt="{scope}:color:{d.key}" aria-pressed={m.channels.color === d.key} title="colour by {d.name} — {d.ord?.length} values" onclick={() => (m.channels.color = d.key)}><span class="w-3">{m.channels.color === d.key ? "✓" : ""}</span><span class="truncate">{d.name}</span></button></li>{/each}
            {#each scalarDims as d}<li><button data-opt="{scope}:color:{d.key}" aria-pressed={m.channels.color === d.key} title="colour by {d.name} (a gradient low → high)" onclick={() => (m.channels.color = d.key)}><span class="w-3">{m.channels.color === d.key ? "✓" : ""}</span><span class="truncate">{d.source === "axis" ? "axis: " + d.name : d.name}</span></button></li>{/each}
            {@render propItems(colorDim)}
          </ul>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>

  <!-- SIZE -->
  <Popover.Root>
    <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:size" aria-label="size">
      <span class="opacity-60">size</span><span class="max-w-[8rem] truncate font-medium">{sizeLabel}</span><span class="text-[9px] opacity-50">▾</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="eido-pop thin-sb max-h-[min(28rem,70vh)] w-60 overflow-y-auto p-0" sideOffset={6} align="start">
        <ul class="menu menu-sm w-full p-1">
          <li class="menu-title text-[10px] tracking-widest uppercase">size by</li>
          <li><button data-opt="{scope}:size:uniform" aria-pressed={m.channels.size === "uniform"} title="every card the same radius" onclick={() => (m.channels.size = "uniform")}><span class="w-3">{m.channels.size === "uniform" ? "✓" : ""}</span>uniform</button></li>
          {#each allDims.filter((d) => d.kind === "scalar") as d}
            <li><button data-opt="{scope}:size:{d.key}" aria-pressed={m.channels.size === d.key} title="size by {d.name}" onclick={() => (m.channels.size = d.key)}><span class="w-3">{m.channels.size === d.key ? "✓" : ""}</span><span class="truncate">{d.name}</span></button></li>
          {/each}
          {@render propItems(sizeDim)}
        </ul>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>

  <!-- WINDOW — the scrubber: field picker + the dual-thumb window over the CHOSEN dimension (any scalar or
       temporal one — the label always names it, so the button never claims to be about time when it isn't) -->
  {#if scrubFields.length && scrubRange && scrubField}
    <Popover.Root>
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:window" aria-label="window a dimension — currently {scrubField.name}" title="window the corpus along {scrubField.name}">
        <span class="opacity-60">window</span><span class="max-w-[6rem] truncate">{scrubField.name}</span><span class="max-w-[10rem] truncate font-mono text-xs">{scrubText}</span><span class="text-[9px] opacity-50">▾</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="start">
          <div class="mb-2 flex items-center gap-2">
            <span class="flex-none font-mono text-[10px] uppercase opacity-60">window</span>
            <select bind:value={m.channels.scrub} onchange={resetScrub} data-testid="scrub-field" aria-label="which dimension the scrubber windows" class="select select-xs min-w-0 flex-1">
              {#each scrubFields as f}<option value={f.key}>{f.name}</option>{/each}
            </select>
          </div>
          <div class="scrub">
            {#key scrubNonce}
              <RangeSlider range id="scrubber" min={scrubRange[0]} max={scrubRange[1]} step={(scrubRange[1] - scrubRange[0]) / 240} values={[m.scrubLo ?? scrubRange[0], m.scrubHi ?? scrubRange[1]]}
                on:change={(e) => { const [lo, hi] = e.detail.values; m.scrubLo = lo > scrubRange![0] ? lo : null; m.scrubHi = hi < scrubRange![1] ? hi : null; }} />
            {/key}
          </div>
          <div class="mt-1 flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] opacity-70">{scrubText}</span>
            <button class="btn btn-ghost btn-xs" onclick={resetScrub} title="clear this window (the other filters stay)" aria-label="clear the {scrubField.name} window">clear</button>
          </div>
          {@render propItems(scrubField)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}

  <!-- FIND — substring over title/body, mirrored into the filter chips -->
  <label class="input input-sm w-40 flex-none gap-1">
    <span class="opacity-50">⌕</span>
    <input type="search" value={m.query} oninput={(e) => m.onFind(e.currentTarget.value)} placeholder="find a card…" aria-label="find a card" class="min-w-0 grow" />
  </label>

  <!-- + AXIS — embed a question into a first-class dimension (an axis) you can place on any channel -->
  {#if data?.vectors}
    <Popover.Root>
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:axis" aria-label="add an axis from a question" title="add an axis from a question you ask the corpus">
        <span class="font-medium">+ axis</span>{#if queryDims.length}<span class="badge badge-xs badge-primary">{queryDims.length}</span>{/if}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="end">
          <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">axis from a question</div>
          <div class="flex gap-1">
            <input bind:value={semQuery} onkeydown={(e) => e.key === "Enter" && runQuery()} placeholder="e.g. arguments about scaling" aria-label="the question this axis measures" disabled={querying} class="input input-sm min-w-0 flex-1" />
            <button onclick={runQuery} disabled={querying || !semQuery.trim()} title="embed the question and add it as an axis you can place on any channel" aria-label="add this axis" class="btn btn-sm btn-primary flex-none normal-case">{querying ? "…" : "add"}</button>
          </div>
          {#if querying}
            <div class="mt-2 flex items-center gap-1.5 text-[11px] opacity-70">
              <span class="inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-primary"></span>
              <span class="min-w-0 flex-1 truncate">{queryStatus || "working…"}</span>
            </div>
            {#if queryPct != null}<progress class="progress progress-primary mt-1 h-1 w-full" value={queryPct} max="100"></progress>{/if}
          {:else if queryErr}
            <div class="mt-2 text-[11px] leading-snug text-error">{queryErr}</div>
          {/if}
          {#each queryDims as qd}
            <div class="rounded-field mt-2 flex items-center gap-1 bg-base-200 px-2 py-1 text-[11px]">
              <span class="min-w-0 flex-1 truncate font-mono opacity-80" title={qd.name}>{qd.name}</span>
              <button onclick={() => (m.channels.color = qd.key)} title="colour by this axis" aria-label="colour by this axis" class="btn btn-ghost btn-xs">●</button>
              <button onclick={() => m.removeQuery(qd.key)} title="remove this axis" aria-label="remove this axis" class="btn btn-ghost btn-xs">✕</button>
            </div>
          {/each}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
{/snippet}

{#snippet rightControls(scope: string)}
  <button class="btn btn-sm btn-ghost flex-none normal-case" title="read the corpus as a sortable, filterable list" onclick={() => (deckOpen = true)}>deck</button>
  <button disabled={m.channels.color !== "region"} title={m.channels.color !== "region" ? "region labels show when coloured by region" : "show region labels on the map"}
    aria-pressed={labelsOn} class="btn btn-sm flex-none normal-case {showLabels && m.channels.color === 'region' ? 'btn-active' : 'btn-ghost'}" onclick={() => (showLabels = !showLabels)} aria-label="toggle region labels">region labels</button>
  <button class="btn btn-sm btn-ghost btn-square flex-none" onclick={toggleTheme} aria-label="toggle light or dark theme" title="toggle light / dark">{theme === "dark" ? "☾" : "☀"}</button>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:theme" aria-label="pick a colour theme" title="theme">
      <span class="max-w-[6rem] truncate">{themeName}</span><span class="text-[9px] opacity-50">▾</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="eido-pop w-52 p-1" sideOffset={6} align="end">
        {#each THEMES as t}
          <DropdownMenu.Item role="menuitemradio" aria-checked={themeName === t.id} class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:theme:{t.id}" onSelect={() => setTheme(t.id)}>
            <span class="w-3">{themeName === t.id ? "✓" : ""}</span>
            <span class="flex-1">{t.label}</span>
            <span data-theme={t.id} class="flex flex-none gap-0.5 rounded-sm bg-base-100 p-0.5">
              <span class="h-3 w-1.5 rounded-xs bg-base-content/60"></span><span class="h-3 w-1.5 rounded-xs bg-primary"></span><span class="h-3 w-1.5 rounded-xs bg-secondary"></span><span class="h-3 w-1.5 rounded-xs bg-accent"></span>
            </span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
  <button class="btn btn-sm btn-ghost flex-none normal-case" title="clear every filter, close the open card, and return grain + camera to this map's defaults" onclick={reset}>reset view</button>
{/snippet}

<div class="flex h-screen w-screen flex-col overflow-hidden bg-base-100 text-base-content"
  role="application" aria-label="eidoscope map — drop a .eido file to open it"
  ondragover={(e) => { e.preventDefault(); dragOver = true; }} ondragleave={() => (dragOver = false)} ondrop={onDrop}>
 {#if dragOver}
  <div class="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-base-100/70 backdrop-blur-sm">
   <div class="rounded-box border-2 border-dashed border-base-content/40 px-8 py-6 font-mono text-sm">drop a <b>.eido</b> to open it</div>
  </div>
 {/if}

  <!-- ═══ TOP TOOLBAR — docked, always visible, states the whole view ═══ -->
  {#if data}
    <header class="z-30 flex-none border-b border-base-300 bg-base-200">
      <!-- desktop: one dense row of labelled menus -->
      <div class="hidden items-center gap-1 px-2 py-1.5 sm:flex">
        <div class="flex min-w-0 max-w-[16rem] flex-none items-center gap-2 pr-1">
          <span class="flex-none text-base leading-none">🔭</span>
          <div class="min-w-0">{@render about("bar")}</div>
        </div>
        <div class="divider divider-horizontal mx-0 flex-none"></div>
        <div class="thin-sb flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {@render controls("bar")}
        </div>
        <div class="flex flex-none items-center gap-1 pl-1">
          {@render rightControls("bar")}
        </div>
      </div>

      <!-- mobile: name + a controls button that opens the same contents as a sheet -->
      <div class="flex items-center gap-1 px-2 py-1.5 sm:hidden">
        <div class="min-w-0 flex-1">{@render about("m")}</div>
        <button class="btn btn-sm btn-ghost flex-none normal-case" data-menu="sheet:open" onclick={() => (sheetOpen = true)} aria-label="open controls">controls ▴</button>
        <button class="btn btn-sm btn-ghost flex-none normal-case" onclick={() => (deckOpen = true)}>deck</button>
      </div>

      <!-- ═══ FILTER CHIPS — the most prominent state display on screen. Animated open/closed so the
           map never jumps when a filter lands. ═══ -->
      <div class="grid transition-[grid-template-rows] duration-150 {chips.length ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}">
        <div class="overflow-hidden">
          <div class="flex flex-wrap items-center gap-1 border-t border-base-300 px-2 py-1.5">
            <span class="font-mono text-[10px] uppercase tracking-widest opacity-50">filters</span>
            {#each chips as chip}
              <button onclick={chip.remove} title="remove this filter: {chip.label}" aria-label="remove filter {chip.label}" class="badge badge-sm badge-neutral gap-1 font-mono">
                <span class="max-w-[11rem] truncate">{chip.label}</span><span class="opacity-60">✕</span>
              </button>
            {/each}
            {#if chips.length > 1}<button onclick={() => m.clearFilters()} title="remove every active filter" aria-label="clear all filters" class="btn btn-ghost btn-xs normal-case">clear all filters</button>{/if}
            <span class="ml-auto font-mono text-[10px] opacity-60">{filterMask ? filterMask.reduce((a, v) => a + v, 0) : data.ids.length} / {data.ids.length} cards</span>
          </div>
        </div>
      </div>
    </header>
  {/if}

  <!-- ═══ BODY: map (fills everything left) + docked details pane ═══ -->
  <main class="flex min-h-0 flex-1">
    <div bind:this={mapBox} class="relative min-h-0 min-w-0 flex-1 touch-none">
      <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
      <!-- role="img"+aria-label is the intended pattern: present the canvas as one labeled image and route AT users to the deck list (the real accessible surface) -->
      <canvas bind:this={canvas} class="absolute inset-0 h-full w-full" role="img" aria-label="Document similarity map (visual). Use the deck list for a screen-reader-accessible view of the same cards."></canvas>

      {#if data && m.layout === "axes" && xDim && yDim}
        {@const xp = poles(xDim)}{@const yp = poles(yDim)}
        <div class="pointer-events-none absolute inset-0 font-mono text-xs opacity-60">
          <div class="absolute left-3 top-1/2 max-w-[42%] -translate-y-1/2" title={xp[0]}>← {trunc(xp[0])}</div>
          <div class="absolute right-3 top-1/2 max-w-[42%] -translate-y-1/2 text-right" title={xp[1]}>{trunc(xp[1])} →</div>
          <div class="absolute left-1/2 top-3 max-w-[60%] -translate-x-1/2 truncate" title={yp[1]}>↑ {trunc(yp[1])}</div>
          <div class="absolute bottom-3 left-1/2 max-w-[60%] -translate-x-1/2 truncate" title={yp[0]}>↓ {trunc(yp[0])}</div>
        </div>
      {/if}

      <!-- hover tooltip: a corpus card, or a frontier ghost paper (distinct content, not a mislabeled card) -->
      {#if hovered && data && selected === null}
        <div class="rounded-box pointer-events-none absolute z-10 max-w-xs border border-base-300 bg-base-100/95 p-2.5 text-xs shadow-xl backdrop-blur"
          style="left:{Math.min(hovered.x + 14, (mapBox?.clientWidth ?? 800) - 280)}px; top:{Math.min(hovered.y + 14, (mapBox?.clientHeight ?? 600) - 120)}px">
          {#if hovered.kind === "point"}
            <div class="mb-1 flex items-center gap-1.5 font-mono text-[10px] opacity-60"><span class="h-2 w-2 flex-none rounded-xs" style="background:{rgb(colOf(assignment[hovered.i]))}"></span><span class="truncate">{regionOf(hovered.i)}</span></div>
            <div class="mb-1 font-bold leading-snug">{data.titles[hovered.i]}</div>
            <div class="line-clamp-2 opacity-70">{data.cores[hovered.i].slice(0, 140)}</div>
          {:else}
            <div class="mb-1 font-bold">{hovered.g.title}</div>
            <div class="font-mono text-[10px] opacity-60">frontier paper · cited {hovered.g.n}× in this corpus{hovered.g.arxiv ? " · arXiv:" + hovered.g.arxiv : ""}</div>
            <div class="mt-1 font-mono text-[10px] text-primary">click → open on arXiv ↗</div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- ═══ DETAILS PANE — docked right (a bottom sheet on phones). Never floats over the map centre. ═══ -->
    {#if sidebarOpen && data}
      <div use:focusOnOpen tabindex="-1" role="dialog" aria-label={selected !== null ? "card detail" : "region detail"}
        class="thin-sb fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-auto border-t border-base-300 bg-base-100 p-4 text-sm shadow-2xl sm:relative sm:inset-auto sm:z-auto sm:max-h-none sm:w-88 sm:flex-none sm:border-l sm:border-t-0 sm:shadow-none">
        <button class="btn btn-ghost btn-sm btn-square sticky top-0 float-right ml-2" onclick={() => (selected !== null ? focusCard(null) : togglePin(pinned!))} aria-label="close">✕</button>
        {#if selected !== null}
          <div class="mb-1 pr-8 font-bold">{data.titles[selected]}</div>
          <div data-meta class="mb-2 font-mono text-[10px] opacity-60">{[data.authors?.[selected], dateOf(selected), regionOf(selected)].filter(Boolean).join(" · ")}</div>
          <div class="mb-2 flex flex-wrap gap-3">
            {#if data.urls?.[selected]}<a class="link link-primary font-mono text-xs font-bold" href={data.urls[selected]} target="_blank" rel="noopener">{readerLabel(data.urls[selected])} →</a>{/if}
            {#if data.sources?.[selected]}<a class="link link-primary font-mono text-xs font-bold" href={data.sources[selected]} target="_blank" rel="noopener">{sourceLabel(selected)} →</a>{/if}
          </div>
          <div class="mb-1 text-xs leading-relaxed opacity-80">{data.cores[selected].slice(0, 420)}{data.cores[selected].length > 420 ? "…" : ""}</div>

          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">where it sits</div>
          {#each placements(selected) as p}
            <div class="flex items-center justify-between gap-2 border-b border-base-200 py-1 text-xs" title={(p.s >= 50 ? p.a.high : p.a.low) + " — " + p.note}>
              <span class="truncate opacity-70">{p.a.name}</span>
              <span class="flex-none font-mono text-[10px]">{p.s >= 50 ? "▲" : "▼"} <b>{p.s}</b></span>
            </div>
          {/each}

          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">nearest {data.nbr[selected]?.length ?? 0}</div>
          {#each data.nbr[selected] ?? [] as j}
            <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-base-200" onclick={() => focusCard(j)}>→ {data.titles[j]}</button>
          {/each}
        {:else if pinnedRegion}
          <div class="mb-1 flex items-center gap-2 pr-8 font-bold"><span class="h-3 w-3 flex-none rounded-xs" style="background:{rgb(colOf(pinnedRegion.c))}"></span><span class="truncate">{pinnedRegion.label}</span></div>
          <div class="mb-2 font-mono text-[10px] opacity-60">region · {pinnedRegion.n} cards · grain {m.grain + 1}/{nLevels}</div>
          {#if pinnedBlurb}<div class="mb-2 text-xs leading-relaxed opacity-80">{pinnedBlurb}</div>{/if}
          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">members</div>
          {#each m.membersOf(pinnedRegion.c).slice(0, 200) as i}
            <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-base-200" onclick={() => focusCard(i)}>{data.titles[i]}</button>
          {/each}
        {/if}
      </div>
    {/if}
  </main>

  {#if status}
    <div class="fixed inset-0 z-50 grid place-items-center bg-base-100 px-6">
      <div class="flex max-w-sm flex-col items-center gap-3 text-center font-mono text-sm">
        {#if !loadFailed}<span class="loading loading-spinner loading-md text-primary" aria-hidden="true"></span>{/if}
        <div class={loadFailed ? "" : "opacity-70"} role="status">{status}</div>
        {#if loadFailed}<button class="btn btn-sm" onclick={() => location.reload()}>reload</button>{/if}
      </div>
    </div>
  {/if}

  <!-- mobile controls sheet: the toolbar's contents, stacked -->
  {#if sheetOpen && data}
    <div class="fixed inset-0 z-50 sm:hidden">
      <button class="absolute inset-0 h-full w-full bg-black/50" onclick={() => requestClose()} aria-label="close controls"></button>
      <div use:trapFocus tabindex="-1" role="dialog" aria-label="controls" class="thin-sb absolute inset-x-0 bottom-0 max-h-[85vh] overflow-auto rounded-t-2xl border-t border-base-300 bg-base-100 p-3 shadow-2xl">
        <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-base-content/20"></div>
        <div class="flex flex-col items-stretch gap-2 [&>*]:w-full [&_button[data-menu]]:justify-start">
          {@render controls("sheet")}
          <div class="divider my-0"></div>
          <div class="flex flex-wrap gap-1">{@render rightControls("sheet")}</div>
        </div>
      </div>
    </div>
  {/if}

  <!-- deck / list view — the accessible, sortable/filterable reader (real DOM, keyboard-navigable) -->
  {#if deckOpen && data}
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-2">
      <div use:trapFocus tabindex="-1" role="dialog" aria-modal="true" aria-label="deck reader" class="rounded-box flex h-full max-h-full w-full max-w-4xl flex-col border border-base-300 bg-base-100 p-3 shadow-2xl">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="font-mono text-[10px] opacity-60">{deckList.length} cards</span>
          <label class="flex items-center gap-1 text-xs"><span class="font-mono text-[10px] opacity-60">sort</span>
            <select bind:value={m.channels.sort} aria-label="sort the deck" class="select select-xs">
              {#each scalarDims as d}<option value={d.key}>{d.name}</option>{/each}
            </select></label>
          {#if hasRead}<button class="btn btn-xs normal-case {deckUnread ? 'btn-active' : 'btn-ghost'}" aria-pressed={deckUnread} title="hide cards already marked read" onclick={() => (deckUnread = !deckUnread)}>unread only</button>{/if}
          <input bind:value={deckQ} placeholder="find in list…" aria-label="find in the list — narrows these rows only, not the map" class="input input-xs min-w-0 flex-1" />
          <button class="btn btn-ghost btn-xs btn-square ml-auto" onclick={() => requestClose()} aria-label="close deck">✕</button>
        </div>
        <div class="thin-sb grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
          {#if deckList.length === 0}<div class="col-span-full py-16 text-center font-mono text-xs opacity-60">no cards match “{deckQ}”{deckUnread ? " (unread only)" : ""}</div>{/if}
          {#each deckList as i (i)}
            <button data-deck-card class="rounded-box border border-base-300 bg-base-200 p-2.5 text-left hover:border-primary/50 {data.read?.[i] === true ? 'opacity-60' : ''}" onclick={() => { focusCard(i); deckOpen = false; }}>
              <div class="flex items-start justify-between gap-2">
                <div class="truncate text-[13px] font-bold">{data.titles[i]}</div>
                {#if data.sources?.[i] || data.urls?.[i]}<a href={data.sources?.[i] || data.urls?.[i]} target="_blank" rel="noopener" class="link link-primary flex-none font-mono text-[10px] font-bold" onclick={(e) => e.stopPropagation()}>open →</a>{/if}
              </div>
              <div class="my-1 line-clamp-2 text-[11px] opacity-70">{data.cores[i].slice(0, 160)}</div>
              <div class="flex flex-wrap gap-1">
                <span class="badge badge-xs font-mono">◆ {regionOf(i)}</span>
                {#each topAxes(i) as t}<span class="badge badge-xs badge-ghost font-mono">{axShort(t.n)} {t.s}</span>{/each}
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <!-- first-run intro (remembered in localStorage) -->
  {#if showIntro && data}
    <div class="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
      <div use:trapFocus tabindex="-1" role="dialog" aria-modal="true" aria-label="welcome" class="rounded-box max-w-md border border-base-300 bg-base-100 p-6 shadow-2xl">
        <div class="text-lg font-bold">{prov?.title ?? "the forms of the corpus"} 🔭</div>
        <div class="mt-1 font-mono text-[11px] opacity-60">{data.ids.length} documents · {data.axes.length} discovered axes · {data.k} regions{#if prov?.generated} · {provDate(prov.generated)}{/if}</div>
        {#if prov?.source}<div class="mt-0.5 truncate font-mono text-[10px] opacity-60"><span class="uppercase tracking-widest opacity-70">corpus source</span> {prov.source}</div>{/if}
        <ul class="mt-3 space-y-2 text-sm opacity-80">
          <li><b class="opacity-100">Proximity is similarity</b> — nearby cards are alike; colour is an emergent region, size is influence.</li>
          <li><b class="opacity-100">Slide the grain</b> to move regions from continents to towns; click a region to isolate, double-click the map to drill in.</li>
          <li><b class="opacity-100">Tap any card</b> to read it, see its nearest neighbours, and open the source.</li>
          <li><b class="opacity-100">Open the deck</b> to read the corpus as a sortable, filterable list — or switch layout to axis scatter.</li>
        </ul>
        <button class="btn btn-primary mt-4" onclick={dismissIntro}>explore →</button>
      </div>
    </div>
  {/if}
</div>
