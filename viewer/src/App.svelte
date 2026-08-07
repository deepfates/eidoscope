<script lang="ts">
  import { onMount, untrack } from "svelte";
  import RangeSlider from "svelte-range-slider-pips";
  import { loadMap, mapUrl, decodeEido } from "./loader";
  import { createMap, type MapHandle } from "./deckmap";
  import { col, axisColor } from "./encode";
  import { buildDimensions, scores01, type Dimension } from "./dimensions";
  import { ViewModel, parseUrl, type CameraOp } from "./model.svelte";
  import { embedQuery, cosineAll, resetEmbedder } from "./semantic";
  import type { MapContract } from "../../src/schema";

  // THE MODEL — channels, filters, scrubber, the dimension registry, URL (de)serialization. App keeps the DOM,
  // the deck handle, the camera and the browser APIs; it reads the model and hands it user intent.
  const m = new ViewModel();

  let canvas: HTMLCanvasElement;
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
  let theme = $state<"dark" | "light">("dark");
  let panelOpen = $state(true);   // control panel + legend collapse on small screens so the map is the hero
  let legendOpen = $state(true);

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

  // Pin/isolate is a state mutation (model) plus a camera move (App owns the handle) — the model returns the
  // camera intent rather than reaching for a deck handle it has no business knowing about.
  function applyCamera(op: CameraOp) { if (op?.kind === "fit") handle?.fitToIndices(op.indices); else if (op?.kind === "reset") handle?.resetView(); }
  const togglePin = (c: number) => applyCamera(m.togglePin(c));
  const toggleFacetPin = (v: string) => applyCamera(m.toggleFacetPin(v));

  function setTheme(t: "dark" | "light", persist = true) { theme = t; document.documentElement.dataset.theme = t; if (persist) try { localStorage.setItem("eido-theme", t); } catch {} }
  function toggleTheme() { setTheme(theme === "dark" ? "light" : "dark"); }
  const hasCite = $derived(!!data?.cite?.some((e) => e.length));
  const hasGhosts = $derived(!!data?.ghosts?.length);
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

  // deep-linkable view state (eid-yxqu): the URL always mirrors the current view, so any view — or a
  // specific card — is a shareable link and a reload restores it. replaceState (not push) so it doesn't
  // fight the overlay history (fktf); the ?map= param is preserved.
  let urlReady = false;
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
  $effect(() => { void [m.layout, m.channels.color, m.channels.size, m.grain, m.channels.x, m.channels.y, m.channels.z, m.pinned, m.selected, m.channels.scrub, m.scrubLo, m.scrubHi, m.dimProps, m.filters, m.queries]; if (urlReady) { try { history.replaceState(history.state, "", m.serializeUrl(location.pathname, location.search)); } catch {} } });

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
    m.mount(D);                                          // per-corpus state reset + x/y/z parked on this file's axes
    status = "";
    if (opts?.intro) showIntro = true;                    // a freshly-opened file introduces itself
    const dims0 = buildDimensions(D);   // build the registry ONCE for this mount's accessors
    const ch = m.channels;
    handle = createMap(canvas, D, {
      getColor: m.colorGet(dims0, ch.color, D.levels?.[m.grain] ?? D.cluster), getRadius: m.sizeGet(dims0, ch.size), getX: m.posGet(dims0, ch.x), getY: m.posGet(dims0, ch.y), getZ: m.posGet(dims0, ch.z), posSig: m.posSig, layout: m.layout, showLabels: labelsOn, grain: m.grain, theme,
      onClick: (i) => focusCard(i < 0 ? null : i),
      onHover: (h, x, y) => (hovered = h == null ? null : { ...h, x, y }),
      onGrainChange: (g) => { m.grain = g; m.pinned = null; },
    });
    // read-only introspection seam for the integration suite (drives the REAL built app, asserts real state)
    (window as any).__eido = () => { const d = handle?.debug(); return { grain: m.grain, k: curCount, layout: m.layout, color: m.channels.color, pin: pinned, facetPin, focus: selected, detail: selected !== null, deckOpen, cite: citeOn, ghosts: ghostsOn, theme, hover: hovered ? hovered.kind : null, zoom: d?.zoom ?? 0, labels: d?.labels ?? 0, regions: d?.regions ?? 0, rot: d?.rot ?? null, rotX: d?.rotX ?? null, target: d?.target ?? null, span3: d?.span3 ?? null, filters: chips.map((c) => c.label), visible: filterMask ? filterMask.reduce((a, v) => a + v, 0) : (data?.ids.length ?? 0) }; };
    (window as any).__eidoProject = (xy: number[]) => handle?.project(xy);
    (window as any).__eidoPick = (x: number, y: number) => handle?.pickAt(x, y);
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
      resetEmbedder();   // drop the poisoned/half-loaded model so the next ⌕ retries cleanly
      queryErr = e?.message === "__stall__"
        ? "model download stalled — check your connection, then press ⌕ to retry"
        : "couldn’t run the query (" + String(e?.message ?? e) + ") — press ⌕ to retry";
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
    const l = m.layout, c = m.channels.color, s = m.channels.size, xk = m.channels.x, yk = m.channels.y, zk = m.channels.z, sl = labelsOn, g = m.grain, a = assignment, co = citeOn, go = ghostsOn, th = theme, h = handle, d = data, ad = allDims, dp = m.dimProps, ps = m.posSig;
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
  $effect(() => { m.ensureScrubKey(); });
  $effect(() => { const h = handle, mask = filterMask; if (h) h.setFilterMask(mask); });  // push the mask (pure derived → no write-loop)

  const prov = $derived(data?.provenance);   // so a passed-around file introduces itself
  const provDate = (g?: number) => (g ? new Date(g).toISOString().slice(0, 10) : "");
  $effect(() => { try { document.title = prov?.title ? `${prov.title} · eidoscope 🔭` : "eidoscope 🔭"; } catch {} });
  const weakAxes = $derived(m.layout === "axes" ? (xDim?.weak ? 1 : 0) + (yDim?.weak ? 1 : 0) : 0);
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
    {#if m.layout === "axes" && xDim && yDim}
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
                class="w-11 flex-none rounded border border-[var(--hair2)] py-0.5 text-center font-mono text-[9px] {p.norm === 'rank' ? 'text-[var(--faint)]' : 'bg-[var(--chip)] text-[var(--ink)]'}">{p.norm === "rank" ? "rank" : "honest"}</button>
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
        <select bind:value={m.layout} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="mde">neighbor map</option><option value="axes">axis scatter</option><option value="orbit">3D space</option><option value="axes3d">3D axis scatter</option>
        </select></label>
      {#if m.layout === "axes" || m.layout === "axes3d"}
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">x-axis</span>
          <select bind:value={m.channels.x} title={xDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(xDim)}</label>
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">y-axis</span>
          <select bind:value={m.channels.y} title={yDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(yDim)}</label>
        {#if m.layout === "axes3d"}
          <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">z-axis</span>
            <select bind:value={m.channels.z} title={zDim?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}</select>{@render propToggle(zDim)}</label>
        {/if}
        {#if weakAxes}<div class="mb-1.5 rounded-md bg-[var(--chip2)] px-2 py-1 text-[10px] leading-snug text-[var(--dim)]">~ {weakAxes > 1 ? "minor axes" : "a minor axis"} (under 2% variance) — position is thin, read it loosely</div>{/if}
      {/if}
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">color</span>
        <select bind:value={m.channels.color} title={colorDim?.name ?? "region"} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="region">region</option>{#each allDims.filter((d) => d.kind === "categorical") as d}<option value={d.key}>{d.name}</option>{/each}{#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.source === "axis" ? "axis: " + d.name : d.name}</option>{/each}
        </select>{@render propToggle(colorDim)}</label>
      <label class="flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">size</span>
        <select bind:value={m.channels.size} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="uniform">uniform</option>{#each allDims.filter((d) => d.kind === "scalar") as d}<option value={d.key}>{d.name}</option>{/each}
        </select>{@render propToggle(sizeDim)}</label>
      {#if nLevels > 1}
        <label class="mt-2 flex items-center gap-2 text-xs">
          <span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">grain</span>
          <input type="range" min="0" max={nLevels - 1} bind:value={m.grain} oninput={() => (m.pinned = null)} class="min-w-0 flex-1 accent-[var(--accent)]" aria-label="grain level: how finely the map is divided into regions" aria-valuetext="{curCount} regions" />
          <span class="w-6 flex-none text-right font-mono text-[10px] text-[var(--faint)]">{curCount}</span>
        </label>
      {/if}
      {#if scrubFields.length && scrubRange && scrubField}
        <div class="mt-2">
          <div class="mb-1 flex items-center gap-2 text-xs">
            <select bind:value={m.channels.scrub} onchange={resetScrub} title="which scalar/temporal dimension the scrubber windows" class="w-[72px] flex-none rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1 py-1 font-mono text-[10px] text-[var(--faint)]">{#each scrubFields as f}<option value={f.key}>{f.name}</option>{/each}</select>
            <span class="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-[var(--faint)]">{scrubField.kind === "temporal" ? fmtDate(m.scrubLo ?? scrubRange[0]) + " – " + fmtDate(m.scrubHi ?? scrubRange[1]) : fmtNum(m.scrubLo ?? scrubRange[0], scrubRange[1] - scrubRange[0]) + " – " + fmtNum(m.scrubHi ?? scrubRange[1], scrubRange[1] - scrubRange[0])}</span>
          </div>
          <div class="scrub">
            {#key scrubNonce}
              <RangeSlider range id="scrubber" min={scrubRange[0]} max={scrubRange[1]} step={(scrubRange[1] - scrubRange[0]) / 240} values={[m.scrubLo ?? scrubRange[0], m.scrubHi ?? scrubRange[1]]}
                on:change={(e) => { const [lo, hi] = e.detail.values; m.scrubLo = lo > scrubRange![0] ? lo : null; m.scrubHi = hi < scrubRange![1] ? hi : null; }} />
            {/key}
          </div>
        </div>
      {/if}
      <div class="mt-2 flex gap-2">
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={() => (deckOpen = true)}>deck</button>
        <button disabled={m.channels.color !== "region"} title={m.channels.color !== "region" ? "region labels show when coloured by region" : ""} class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] disabled:opacity-40 disabled:cursor-not-allowed {showLabels && m.channels.color === 'region' ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (showLabels = !showLabels)}>labels</button>
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={reset}>reset</button>
      </div>
      <input type="search" value={m.query} oninput={(e) => m.onFind(e.currentTarget.value)} placeholder="find a card…" class="mt-2 w-full rounded-md border border-[var(--hair2)] bg-[var(--field)] px-2 py-1.5 text-xs" />
      {#if chips.length}
        <div class="mt-2 flex flex-wrap items-center gap-1">
          {#each chips as chip}
            <button onclick={chip.remove} title="remove filter" class="flex items-center gap-1 rounded-full border border-[var(--hair2)] bg-[var(--chip)] px-2 py-0.5 font-mono text-[10px] text-[var(--soft)] hover:text-[var(--ink)]"><span class="max-w-[9rem] truncate">{chip.label}</span> <span class="text-[var(--faint)]">✕</span></button>
          {/each}
          {#if chips.length > 1}<button onclick={() => m.clearFilters()} title="clear all filters" class="rounded-full px-2 py-0.5 font-mono text-[10px] text-[var(--faint)] hover:text-[var(--ink)]">clear all</button>{/if}
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
        {/if}
        {#each queryDims as qd}
          <div class="mt-1 flex items-center gap-1 rounded-md bg-[var(--chip2)] px-2 py-1 text-[10px]">
            <span class="min-w-0 flex-1 truncate font-mono text-[var(--dim)]" title={qd.name}>{qd.name}</span>
            <button onclick={() => (m.channels.color = qd.key)} title="colour by this query" class="flex-none font-mono text-[var(--faint)] hover:text-[var(--ink)]">●</button>
            <button onclick={() => m.removeQuery(qd.key)} title="remove query" class="flex-none font-mono text-[var(--faint)] hover:text-[var(--ink)]">✕</button>
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
        <span class="truncate">{#if m.channels.color === "region"}{curCount} regions{:else if colorDim?.kind === "categorical"}{colorDim.name} · {colorDim.ord?.length}{:else if colorDim}{colorDim.name}{#if colorDim.variance != null}<span class="normal-case text-[var(--faint)]"> · {Math.round(colorDim.variance * 100)}% variance{colorDim.weak ? " (thin)" : ""}</span>{/if}{:else}legend{/if}</span>
      </button>
      {#if legendOpen}
        <div class="thin-sb min-h-0 overflow-auto">
        {#if m.channels.color === "region"}
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
    <div use:trapFocus tabindex="-1" role="dialog" aria-label="card detail" class="thin-sb absolute bottom-3 left-3 right-3 max-h-[64vh] overflow-auto rounded-xl border border-[var(--hair)] bg-[var(--panel)] p-4 text-sm backdrop-blur sm:right-auto sm:w-80">
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
        <span class="font-mono text-[10px] text-[var(--faint)]">{deckList.length} cards</span>
        <label class="flex items-center gap-1 text-xs"><span class="font-mono text-[10px] text-[var(--faint)]">sort</span>
          <select bind:value={m.channels.sort} class="rounded-md border border-[var(--hair2)] bg-[var(--card)] px-1.5 py-1 text-xs">
            {#each allDims.filter((d) => d.kind !== "categorical") as d}<option value={d.key}>{d.name}</option>{/each}
          </select></label>
        {#if hasRead}<button class="rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] {deckUnread ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (deckUnread = !deckUnread)}>unread only</button>{/if}
        <input bind:value={deckQ} placeholder="filter…" class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--card)] px-2 py-1 text-xs" />
        <button class="ml-auto grid h-7 w-7 flex-none place-items-center rounded-md font-mono text-sm text-[var(--faint)] hover:bg-[var(--chip)] hover:text-[var(--ink)]" onclick={() => requestClose()} aria-label="close deck">✕</button>
      </div>
      <div class="thin-sb grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
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
  /* scrollable regions that shouldn't advertise a chrome scrollbar — still scrolls, just quietly (thin on
     firefox, hidden track on webkit; the content fades are enough of an affordance). */
  .thin-sb { scrollbar-width: thin; scrollbar-color: var(--hair2) transparent; }
  .thin-sb::-webkit-scrollbar { width: 6px; height: 6px; }
  .thin-sb::-webkit-scrollbar-thumb { background: var(--hair2); border-radius: 3px; }
  .thin-sb::-webkit-scrollbar-track { background: transparent; }
</style>
