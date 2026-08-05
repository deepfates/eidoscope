<script lang="ts">
  import { onMount } from "svelte";
  import { loadMap, mapUrl, decodeEido } from "./loader";
  import { createMap, type MapHandle, type Layout } from "./deckmap";
  import { facets, colorFor, sizeFor, col, axisColor, type Facet } from "./encode";
  import type { MapContract } from "../../src/schema";

  let canvas: HTMLCanvasElement;
  let status = $state("loading your map…");
  let loadFailed = $state(false);
  let data = $state<MapContract | null>(null);
  let selected = $state<number | null>(null);
  let hovered = $state<{ kind: "point"; i: number; x: number; y: number } | { kind: "ghost"; g: any; x: number; y: number } | null>(null);
  let color = $state("cluster");
  let size = $state("hub");
  let layout = $state<Layout>("mde");
  let xKey = $state("");
  let yKey = $state("");
  let fac = $state<Facet[]>([]);
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
  let showIntro = $state(false);
  let citeOn = $state(false);
  let ghostsOn = $state(false);
  let theme = $state<"dark" | "light">("dark");
  let panelOpen = $state(true);   // control panel + legend collapse on small screens so the map is the hero
  let legendOpen = $state(true);
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
    list.sort((a, b) => (deckSort === "hub" ? data!.hub[b] - data!.hub[a] : (data!.scores[deckSort]?.[b] ?? 0) - (data!.scores[deckSort]?.[a] ?? 0)));
    return list.slice(0, 2000);  // show the whole corpus (was 300 — which hid most cards + masked "unread only")
  });
  const labelsOn = $derived(showLabels && color === "cluster");  // 3D now has proper billboarded region labels (isomorphic with 2D)
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
  function togglePin(c: number) {
    if (pinned === c) { pinned = null; handle?.setHighlight(null); handle?.resetView(); }
    else { pinned = c; facetPin = null; handle?.setHighlight(c); handle?.fitToIndices(membersOf(c)); }
  }
  const facetMembers = (v: string) => { const out: number[] = []; if (!curFacet || !data) return out; for (let i = 0; i < data.ids.length; i++) if (curFacet.get(i) === v) out.push(i); return out; };
  function toggleFacetPin(v: string) {
    if (facetPin === v) { facetPin = null; handle?.setHighlightSet(null, null); handle?.resetView(); }
    else { facetPin = v; pinned = null; const idx = facetMembers(v); handle?.setHighlightSet(idx, col(curFacet!.idx[v])); handle?.fitToIndices(idx); }
  }
  // switching the colour lens clears a stale facet isolate (a folder value means nothing under a different lens)
  let lastColorForFacet = color;
  $effect(() => { const c = color; if (c !== lastColorForFacet) { lastColorForFacet = c; if (facetPin !== null) { facetPin = null; handle?.setHighlightSet(null, null); } } });

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
  function reset() { focusCard(null); pinned = null; facetPin = null; handle?.setHighlight(null); handle?.setHighlightSet(null, null); grain = data?.di ?? 0; handle?.resetView(); }

  // deep-linkable view state (eid-yxqu): the URL always mirrors the current view, so any view — or a
  // specific card — is a shareable link and a reload restores it. replaceState (not push) so it doesn't
  // fight the overlay history (fktf); the ?map= param is preserved.
  let urlReady = false;
  function serializeUrl(): string {
    const p = new URLSearchParams();
    const m = new URLSearchParams(location.search).get("map"); if (m) p.set("map", m);
    if (layout !== "mde") p.set("layout", layout);
    if (color !== "cluster") p.set("color", color);
    if (size !== "hub") p.set("size", size);
    if (data && grain !== (data.di ?? 0)) p.set("grain", String(grain));
    if (layout === "axes") { if (xKey) p.set("x", xKey); if (yKey) p.set("y", yKey); }
    if (pinned !== null) p.set("region", String(pinned));
    if (facetPin !== null) p.set("facet", facetPin);
    if (selected !== null && data) p.set("card", data.ids[selected]);
    const q = p.toString();
    return location.pathname + (q ? "?" + q : "");
  }
  function applyUrlState() {
    const p = new URLSearchParams(location.search);
    const L = p.get("layout"); if (L === "mde" || L === "axes" || L === "orbit") layout = L;
    const c = p.get("color"); if (c) { color = c; lastColorForFacet = c; }  // keep the facet-clear effect from firing on this restore
    const s = p.get("size"); if (s) size = s;
    const x = p.get("x"); if (x) xKey = x;
    const y = p.get("y"); if (y) yKey = y;
    const g = p.get("grain"); if (g && !Number.isNaN(+g)) grain = Math.max(0, Math.min((data?.counts?.length ?? 1) - 1, Math.round(+g)));
    // region + card depend on grain-derived state, so apply once the reactive graph has settled
    queueMicrotask(() => {
      const r = p.get("region"); if (r && !Number.isNaN(+r) && +r >= 0 && +r < curCount) togglePin(+r);
      const fp = p.get("facet"); if (fp && curFacet && curFacet.ord.includes(fp)) toggleFacetPin(fp);
      const card = p.get("card"); if (card && data) { const i = data.ids.indexOf(card); if (i >= 0) focusCard(i); }
    });
  }
  $effect(() => { void [layout, color, size, grain, xKey, yKey, pinned, selected]; if (urlReady) { try { history.replaceState(history.state, "", serializeUrl()); } catch {} } });

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
    fac = facets(D);
    xKey = D.axes[0]?.key ?? "";
    yKey = D.axes[1]?.key ?? D.axes[0]?.key ?? "";
    grain = D.di ?? 0;
    data = D;
    status = "";
    if (opts?.intro) showIntro = true;                    // a freshly-opened file introduces itself
    handle = createMap(canvas, D, {
      getColor: colorFor(D, color, fac, D.levels?.[grain] ?? D.cluster), getRadius: sizeFor(D, size), layout, xKey, yKey, showLabels: labelsOn, grain, theme,
      onClick: (i) => focusCard(i < 0 ? null : i),
      onHover: (h, x, y) => (hovered = h == null ? null : { ...h, x, y }),
      onGrainChange: (g) => { grain = g; pinned = null; },
    });
    // read-only introspection seam for the integration suite (drives the REAL built app, asserts real state)
    (window as any).__eido = () => { const d = handle?.debug(); return { grain, k: curCount, layout, color, pin: pinned, facetPin, focus: selected, detail: selected !== null, deckOpen, cite: citeOn, ghosts: ghostsOn, theme, hover: hovered ? hovered.kind : null, zoom: d?.zoom ?? 0, labels: d?.labels ?? 0, regions: d?.regions ?? 0, rot: d?.rot ?? null, rotX: d?.rotX ?? null, pos: d?.pos ?? null, span3: d?.span3 ?? null }; };
    (window as any).__eidoProject = (xy: number[]) => handle?.project(xy);
    (window as any).__eidoPick = (x: number, y: number) => handle?.pickAt(x, y);
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
    const l = layout, c = color, s = size, xk = xKey, yk = yKey, sl = labelsOn, g = grain, a = assignment, co = citeOn, go = ghostsOn, th = theme, h = handle, d = data, f = fac;
    if (h && d) h.update({ getColor: colorFor(d, c, f, a), getRadius: sizeFor(d, s), layout: l, xKey: xk, yKey: yk, showLabels: sl, grain: g, citeOn: co, ghostsOn: go, theme: th });
  });
  $effect(() => { const q = query, h = handle; if (h) h.setQuery(q); }); // search dims non-matching map points

  // TIME SCRUBBER (first channel-grammar scrubber): reveal cards cumulatively by date via deck's GPU
  // DataFilterExtension (filterSoftRange fades the leading edge). Only shown when the corpus carries dates.
  let scrubT = $state<number | null>(null);
  const dateRange = $derived.by((): [number, number] | null => {
    const ds = (data?.dates ?? []).filter((d): d is number => typeof d === "number");
    return ds.length >= 2 ? [Math.min(...ds), Math.max(...ds)] : null;
  });
  const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  $effect(() => { if (dateRange && scrubT === null) scrubT = dateRange[1]; });   // init full (no filtering)
  $effect(() => {
    const h = handle, dr = dateRange, t = scrubT, ds = data?.dates;
    if (!h) return;
    if (dr && ds && t != null && t < dr[1]) h.setScrub((i) => (typeof ds[i] === "number" ? (ds[i] as number) : dr[0] - 1), [dr[0], t]);
    else h.setScrub(null, null);   // slid to the end (or no dates) → show everything
  });

  const curFacet = $derived(fac.find((f) => "meta:" + f.key === color));
  const legendAxis = $derived(data?.axes.find((x) => x.key === color));
  const xAxis = $derived(data?.axes.find((a) => a.key === xKey));
  const yAxis = $derived(data?.axes.find((a) => a.key === yKey));
  const hint = $derived(layout === "axes" ? "positioned by where each card projects on the two axes" : layout === "orbit" ? "drag to look · arrow keys / scroll to fly through" : "proximity = similarity · tap a card");
  const prov = $derived(data?.provenance);   // so a passed-around file introduces itself
  const provDate = (g?: number) => (g ? new Date(g).toISOString().slice(0, 10) : "");
  $effect(() => { try { document.title = prov?.title ? `${prov.title} · eidoscope 🔭` : "eidoscope 🔭"; } catch {} });
  const weakAxes = $derived(layout === "axes" ? (xAxis?.weak ? 1 : 0) + (yAxis?.weak ? 1 : 0) : 0);
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
    {#if layout === "axes" && xAxis && yAxis}
      <div class="pointer-events-none absolute inset-0 font-mono text-xs text-[var(--dim)]">
        <div class="absolute left-3 top-1/2 max-w-[42%] -translate-y-1/2" title={xAxis.low}>← {trunc(xAxis.low)}</div>
        <div class="absolute right-3 top-1/2 max-w-[42%] -translate-y-1/2 text-right" title={xAxis.high}>{trunc(xAxis.high)} →</div>
        <div class="absolute left-1/2 top-3 max-w-[60%] -translate-x-1/2 truncate" title={yAxis.high}>↑ {trunc(yAxis.high)}</div>
        <div class="absolute bottom-9 left-1/2 max-w-[60%] -translate-x-1/2 truncate" title={yAxis.low}>↓ {trunc(yAxis.low)}</div>
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
      {#if prov?.title}<div class="-mt-1 mb-0.5 truncate text-sm font-bold text-[var(--ink)]" title={prov.source ?? ""}>{prov.title}</div>{/if}
      <div class="mb-2 text-xs text-[var(--dim)]">{data.ids.length} cards · {curCount} regions</div>
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">layout</span>
        <select bind:value={layout} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="mde">neighbor map</option><option value="axes">axis scatter</option><option value="orbit">3D fly-through</option>
        </select></label>
      {#if layout === "axes"}
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">x-axis</span>
          <select bind:value={xKey} title={xAxis?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}</select></label>
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">y-axis</span>
          <select bind:value={yKey} title={yAxis?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}</select></label>
        {#if weakAxes}<div class="mb-1.5 rounded-md bg-[var(--chip2)] px-2 py-1 text-[10px] leading-snug text-[var(--dim)]">~ {weakAxes > 1 ? "both are minor axes" : "a minor axis"} (under 2% variance) — position is thin, read it loosely</div>{/if}
      {/if}
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">color</span>
        <select bind:value={color} title={legendAxis?.name ?? ""} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="cluster">region</option>{#each fac as f}<option value={"meta:" + f.key}>{f.label}</option>{/each}{#each data.axes as a}<option value={a.key}>axis: {axl(a)}</option>{/each}
        </select></label>
      <label class="flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">size</span>
        <select bind:value={size} class="min-w-0 flex-1 rounded-md border border-[var(--hair2)] bg-[var(--field)] px-1.5 py-1 text-xs">
          <option value="uniform">uniform</option><option value="hub">influence (hub)</option>{#each data.axes as a}<option value={a.key}>commit: {axl(a)}</option>{/each}
        </select></label>
      {#if nLevels > 1}
        <label class="mt-2 flex items-center gap-2 text-xs">
          <span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">grain</span>
          <input type="range" min="0" max={nLevels - 1} bind:value={grain} oninput={() => (pinned = null)} class="min-w-0 flex-1 accent-[var(--accent)]" aria-label="grain level: how finely the map is divided into regions" aria-valuetext="{curCount} regions" />
          <span class="w-6 flex-none text-right font-mono text-[10px] text-[var(--faint)]">{curCount}</span>
        </label>
      {/if}
      {#if dateRange}
        <label class="mt-2 flex items-center gap-2 text-xs">
          <span class="w-9 flex-none font-mono text-[10px] text-[var(--faint)]">time</span>
          <input type="range" min={dateRange[0]} max={dateRange[1]} step={(dateRange[1] - dateRange[0]) / 240} bind:value={scrubT} class="min-w-0 flex-1 accent-[var(--accent)]" aria-label="reveal cards up to this date" />
          <span class="w-[52px] flex-none text-right font-mono text-[9px] text-[var(--faint)]">{fmtDate(scrubT ?? dateRange[1])}</span>
        </label>
      {/if}
      <div class="mt-2 flex gap-2">
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={() => (deckOpen = true)}>deck</button>
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] {showLabels ? 'bg-[var(--chip)] text-[var(--ink)]' : 'text-[var(--faint)]'}" onclick={() => (showLabels = !showLabels)}>labels</button>
        <button class="flex-1 rounded-md border border-[var(--hair2)] px-2 py-1 font-mono text-[11px] text-[var(--soft)] hover:bg-[var(--chip)]" onclick={reset}>reset</button>
      </div>
      <input type="search" bind:value={query} placeholder="find a card…" class="mt-2 w-full rounded-md border border-[var(--hair2)] bg-[var(--field)] px-2 py-1.5 text-xs" />
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
        <span class="truncate">{#if color === "cluster"}{curCount} regions{#if legendOpen}<span class="normal-case text-[var(--faint)]"> · click to isolate</span>{/if}{:else if curFacet}{curFacet.label} · {curFacet.ord.length}{#if legendOpen}<span class="normal-case text-[var(--faint)]"> · click to isolate</span>{/if}{:else if legendAxis}{legendAxis.name}{#if pct(legendAxis) != null}<span class="normal-case text-[var(--faint)]"> · {pct(legendAxis)}% variance{legendAxis.weak ? " (thin)" : ""}</span>{/if}{:else}legend{/if}</span>
      </button>
      {#if legendOpen}
        <div class="min-h-0 overflow-auto">
        {#if color === "cluster"}
          {#each curClusters as c}<div class="flex cursor-pointer items-center gap-2 py-1.5 hover:text-[var(--ink)] {pinned === c.c ? 'text-[var(--ink)] font-semibold' : ''}" role="button" tabindex="0" aria-label="isolate region {c.label}" aria-pressed={pinned === c.c} onmouseenter={() => { if (pinned === null) handle?.setHighlight(c.c); }} onmouseleave={() => { if (pinned === null) handle?.setHighlight(null); }} onclick={() => togglePin(c.c)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(c.c); } }}><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(c.c))}"></span><span class="truncate">{c.label} <span class="text-[var(--faint)]">{c.n}</span></span></div>{/each}
        {:else if curFacet}
          {#each curFacet.ord.slice(0, 16) as v}<div class="flex cursor-pointer items-center gap-2 py-1.5 hover:text-[var(--ink)] {facetPin === v ? 'text-[var(--ink)] font-semibold' : ''}" role="button" tabindex="0" aria-label="isolate {curFacet.label} {v}" aria-pressed={facetPin === v} onclick={() => toggleFacetPin(v)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFacetPin(v); } }}><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(curFacet.idx[v]))}"></span><span class="truncate">{v} <span class="text-[var(--faint)]">{curFacet.cnt[v]}</span></span></div>{/each}
          {#if curFacet.ord.length > 16}<div class="text-[var(--faint)]">+{curFacet.ord.length - 16} more</div>{/if}
        {:else if legendAxis}
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(0))}"></span>{legendAxis.low}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(1))}"></span>{legendAxis.high}</div>
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
        <div class="mb-1 font-bold">{data.titles[hovered.i]}</div>
        <div class="mb-1 line-clamp-2 text-[var(--dim)]">{data.cores[hovered.i].slice(0, 140)}</div>
        <div class="font-mono text-[10px] text-[var(--faint)]">hub {data.hub[hovered.i]} · {topAxes(hovered.i).map((t) => t.n + " " + t.s).join(" · ")}</div>
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
            <option value="hub">influence</option>{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}
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
