<script lang="ts">
  import { onMount, untrack } from "svelte";
  import RangeSlider from "svelte-range-slider-pips";
  import { DropdownMenu, Popover } from "bits-ui";
  import { loadMap, mapUrl, decodeEido, type Store } from "./loader";
  import { createMap, type MapHandle } from "./deckmap";
  import { col, setColorData, setColorGroups, setActiveTheme } from "./encode";
  import { themePalette } from "./palette";
  import { buildDimensions, scores01, rampFor, type Dimension } from "./dimensions";
  import { ViewModel, parseUrl, type CameraOp, type StatePatch } from "./model.svelte";
  import { cosineAll } from "./semantic";
  import { deriveDirection } from "./derive";
  import { resolveIdSet, type UrlIdSet } from "./idset";
  import { GRAIN_MIN_REGION, GRAIN_RATIO, GRAIN_PALETTE_N, type SavedView, type ViewState } from "../../src/schema";
  import { encodeContainer } from "../../src/eido-container";
  import { gzipSync, zipSync, strToU8 } from "fflate";
  import Ingest from "./Ingest.svelte";
  import HuggingFace from "./connectors/HuggingFace.svelte";
  import type { CorpusPayload } from "./connectors/types";
  import { engine, filesFromFileList, filesFromDataTransfer, getKey, type IngestFile, type IngestStatus } from "./ingest";
  import type { MapContract } from "../../src/schema";
  import { injectEido, vaultEntries, deckJSONL } from "../../src/export";
  import { setSource, currentFileName, canWriteInPlace, supportsFSA, openViaPicker, openRecent, listRecents, writeEido, download, type RecentFile } from "./file";

  // THE MODEL — channels, filters, scrubber, the dimension registry, URL (de)serialization. App keeps the DOM,
  // the deck handle, the camera and the browser APIs; it reads the model and hands it user intent.
  const m = new ViewModel();

  let canvas: HTMLCanvasElement;
  let mapBox = $state<HTMLElement | null>(null);   // the map's own box (toolbar sits above it now)
  let status = $state("loading your map…");
  let loadFailed = $state(false);
  let hovered = $state<{ kind: "point"; i: number; x: number; y: number } | { kind: "ghost"; g: any; x: number; y: number } | null>(null);
  let handle = $state<MapHandle | null>(null);
  // the mounted STORE (src/store.ts) — the read seam. The model/renderer consume the materialized
  // contract (store.map(), mirrored as `data` via m.data); the vector-reading operators (derive, the
  // semantic query) read store.vectors() so a future ColumnarStore can serve them without a full decode.
  let store = $state<Store | null>(null);
  let semQuery = $state("");                 // the query-box text (distinct from m.query, the substring find)
  let querying = $state(false);
  let queryErr = $state("");
  let queryStatus = $state("");   // live line while the first query downloads the model / embeds
  let queryPct = $state<number | null>(null);   // download % when known (drives the thin progress bar)
  let showIntro = $state(false);
  let isoOpen = $state<string | null>(null);   // which categorical dimension's value list is expanded in the colour popover (M-A4)
  let sheetOpen = $state(false);   // the toolbar's contents as a bottom sheet (mobile always; desktop when folded)

  // ═══ PRIORITY COLLAPSE (eid-ef7e) — the desktop strip never clips a control mid-glyph. Below the
  // measured fit width, lower-priority controls FOLD into the SAME controls sheet mobile uses (one
  // affordance: "controls ▴" → sheetOpen). Tiers, folding earliest → latest, per the priority ruling
  // (select · layout · color+grain · deck · reset view stay visible longest):
  //   1 axes · size · window · find · +axis · labels · theme toggle · theme picker
  //   2 reset view      3 deck      4 color · grain      0 = never (select, layout)
  // The threshold is MEASURED, not hand-carved: folded controls stay in the DOM as absolute+invisible
  // (out of flow but measurable), so needed(f) is the sum of real rendered widths — it adapts to
  // whatever labels this corpus and layout produce. A ResizeObserver (width) + MutationObserver
  // (content: the axes menu appearing, a label changing) re-run the same pure comparison.
  let fold = $state(0);
  const FOLD_MAX = 4;
  const FOLDED = "pointer-events-none invisible absolute";
  const foldCls = (scope: string, tier: number) => (scope === "bar" && tier > 0 && fold >= tier ? FOLDED : "");
  function measureFold(row: HTMLElement) {
    const GAP = 4, SLACK = 40;   // the strip's gap-1, + the row's paddings/dividers not itemized below
    const els = [...row.querySelectorAll<HTMLElement>("[data-fold]")];
    if (!els.length) return;
    let fixed = SLACK;
    for (const el of row.querySelectorAll<HTMLElement>("[data-fold-fixed]")) fixed += el.getBoundingClientRect().width + GAP;
    const wTrig = (row.querySelector<HTMLElement>("[data-fold-trigger]")?.getBoundingClientRect().width ?? 0) + GAP;
    const avail = row.clientWidth;
    let f = 0;
    for (; f < FOLD_MAX; f++) {
      let need = fixed + (f > 0 ? wTrig : 0);
      for (const el of els) { const t = +(el.dataset.fold || 0); if (t === 0 || t > f) need += el.getBoundingClientRect().width + GAP; }
      if (need <= avail) break;
    }
    if (f !== fold) fold = f;
  }
  function foldWatch(node: HTMLElement) {
    const run = () => measureFold(node);
    const ro = new ResizeObserver(run); ro.observe(node);
    // childList + characterData only (NOT attributes) — our own class flips don't re-trigger, so no loop
    const mo = new MutationObserver(run); mo.observe(node, { childList: true, subtree: true, characterData: true });
    run();
    return { destroy() { ro.disconnect(); mo.disconnect(); } };
  }

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
  // the active scalar dimension's theme-derived ramp (legend swatches + gradient pole rows)
  const rampOf = $derived.by(() => { void palVer; const d = m.colorDim; return d && d.kind !== "categorical" ? rampFor(d, m.propsOf(d)) : null; });
  // The palette is sized to what the colour channel actually shows: the region count at this grain,
  // or a categorical dimension's value count (deepfates' ruling 2026-08-10 — no fixed colour count,
  // no modulo recycling; coarse maps get few well-separated colours, fine maps get exactly as many
  // as there are regions).
  // ONE colour system (eid-zsij): the map's colour coordinates are handed to the engine once per map;
  // the colour channel's GROUPS (region assignment at the live grain, or a categorical dimension's
  // per-card value index) get hues from their member centroids on the colour disc — similar groups
  // wear similar hues, across every view. When a scalar dimension holds the colour channel, `col()`
  // still serves the REGION palette (hover chips, hulls, region legend rows). Files without colour
  // coordinates fall back to the spread-k themed ring inside the engine.
  const catAssign = (d: Dimension): Int32Array => {
    const n = data?.ids.length ?? 0, out = new Int32Array(n);
    for (let i = 0; i < n; i++) { const v = d.cat!(i); out[i] = v == null ? -1 : (d.idx![v] ?? -1); }
    return out;
  };
  $effect(() => {
    setColorData(data?.colorCoords);
    palVer = colorDim?.kind === "categorical"
      ? setColorGroups(catAssign(colorDim), colorDim.ord?.length ?? 24)
      : setColorGroups(assignment, curCount);
  });

  // read-only views onto the model, so the markup below reads as plainly as it did when the state was inline
  const data = $derived(m.data);
  const selected = $derived(m.selected);
  const pinned = $derived(m.pinned);
  const facetPin = $derived(m.facetPin);
  const allDims = $derived(m.allDims);
  const queryDims = $derived(m.queryDims);
  const mintedDims = $derived(m.mintedDims);   // queries + derived — one list, one ✕ path
  const colorDim = $derived(m.colorDim), xDim = $derived(m.xDim), yDim = $derived(m.yDim), zDim = $derived(m.zDim), sizeDim = $derived(m.sizeDim);
  const assignment = $derived(m.assignment);
  const curCount = $derived(m.curCount);
  const curClusters = $derived(m.curClusters);
  const nLevels = $derived(m.nLevels);
  const chips = $derived(m.chips);
  const selection = $derived(m.selection);
  const selectMode = $derived(m.selectMode);
  const filterMask = $derived(m.filterMask);
  // the corpus scope, one number everything reads: cards passing every filter (= all of them when none)
  const visibleCount = $derived(filterMask ? filterMask.reduce((a, v) => a + v, 0) : (data?.ids.length ?? 0));
  const scrubFields = $derived(m.scrubFields), scrubField = $derived(m.scrubField), scrubRange = $derived(m.scrubRange);
  const propsOf = m.propsOf, poles = m.poles;
  const setProp = (d: Dimension, patch: Parameters<typeof m.setProp>[1]) => m.setProp(d, patch);
  const scalarDims = $derived(allDims.filter((d) => d.kind !== "categorical"));
  const catDims = $derived(allDims.filter((d) => d.kind === "categorical"));
  // colour can only speak about a legible number of values — a 9,000-artist legend says nothing. Wide
  // categoricals stay available on every OTHER channel (sort, find, facet, window): eid-ml88.
  const colourCatDims = $derived(catDims.filter((d) => !d.wide));

  // Pin/isolate is a state mutation (model) plus a camera move (App owns the handle) — the model returns the
  // camera intent rather than reaching for a deck handle it has no business knowing about.
  // THE INTERACTION LAW: one action changes one thing. Isolating is a FILTER — it must not also fly the
  // camera (that was "I clicked a legend row and the map jumped somewhere else", and it made every
  // ?region= deep link re-frame the view the sharer had chosen). The camera moves only when the user
  // asks: the `fit` button in the pane, or `reset view`. Releasing an isolate likewise leaves the camera.
  function applyCamera(op: CameraOp) { if (op?.kind === "reset") return; /* deliberately ignore `fit` — see above */ }
  const togglePin = (c: number) => { const op = m.togglePin(c); if (m.pinned === null) handle?.setHighlight(null); applyCamera(op); };
  const toggleFacetPin = (v: string) => applyCamera(m.toggleFacetPin(v));
  const fitTo = (idx: number[]) => handle?.fitToIndices(idx);   // the explicit, user-asked-for camera move

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
  // Close the TOPMOST overlay only — Escape with a card open behind the deck used to close both, which is
  // the "one action changes one thing" law applied to dismissal. Order = stacking order, innermost first.
  function doCloseOverlays() {
    if (showIntro) { try { localStorage.setItem("eido-seen", "1"); } catch {} showIntro = false; return; }
    if (sheetOpen) { sheetOpen = false; return; }
    if (m.deckOpen) { m.deckOpen = false; return; }
    if (selection !== null) { m.clearSelection(); return; }
    if (selected !== null) { focusCard(null); return; }
    if (pinned !== null) togglePin(pinned);
  }
  function requestClose() { if (overlayPushed) { try { history.back(); return; } catch {} } doCloseOverlays(); }
  function dismissIntro() { requestClose(); }
  $effect(() => { const anyOpen = showIntro || m.deckOpen || sheetOpen || selected !== null; if (anyOpen && !overlayPushed) { try { history.pushState({ eido: 1 }, ""); } catch {} overlayPushed = true; } });
  const hasRead = $derived(!!data?.read?.some((r) => r === true || r === false));
  const axShort = (name: string) => name.split(/ vs\.? | and /i)[0].slice(0, 15);
  const deckList = $derived.by(() => {
    if (!data) return [] as number[];
    // LINKED VIEWS: the deck is the accessible parallel of the map, so it must show the SAME cards.
    // It used to ignore filterMask entirely — isolate a 208-card region and the deck still listed all
    // 13,830, which quietly made the two surfaces disagree about what corpus you were looking at.
    const mask = filterMask;
    let list = data.ids.map((_, i) => i).filter((i) => !mask || mask[i] === 1);
    const q = m.deckQ.trim().toLowerCase();
    if (q) list = list.filter((i) => data!.titles[i].toLowerCase().includes(q) || data!.cores[i].toLowerCase().includes(q));
    if (m.deckUnread && hasRead) list = list.filter((i) => data!.read![i] !== true);
    const sd = allDims.find((x) => x.key === m.channels.sort);   // sort by any scalar dimension (influence, length, axis, query…)
    const sv = sd && sd.kind !== "categorical" ? scores01(sd, propsOf(sd)) : null;
    if (sv) list.sort((a, b) => (sv[b] ?? 0) - (sv[a] ?? 0));
    return list.slice(0, 2000);  // show the whole corpus (was 300 — which hid most cards + masked "unread only")
  });
  const labelsOn = $derived(m.showLabels && m.channels.color === "region");  // 3D now has proper billboarded region labels (isomorphic with 2D)
  // switching the colour lens drops stale facet filters (a folder value means nothing under a different lens)

  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const trunc = (s: string, m2 = 44) => (s && s.length > m2 ? s.slice(0, m2 - 1) + "…" : s);
  const regionOf = (i: number) => curClusters[assignment[i]]?.label ?? "";
  // honest labeling wherever a dimension is offered: a discovered axis carries its variance share, and a
  // thin one (under the 2% floor the pipeline flags as `weak`) says so — same "thin" word the about pane
  // and the scatter caption already use. No hiding, no reordering: just the number, everywhere.
  const pctOf = (v: number) => { const p = v * 100; return (p >= 2 ? Math.round(p) : +p.toFixed(1)) + "%"; };
  const dimTag = (d: { variance?: number }) => (d.variance == null ? "" : ` · ${pctOf(d.variance)}`);
  const readerLabel = (u?: string) => (u && /readwise\.io/.test(u) ? "Readwise" : "open");
  const sourceLabel = (i: number) => data?.siteNames?.[i] || "original";
  const dateOf = (i: number) => { const d = data?.dates?.[i]; return d ? new Date(d).toISOString().slice(0, 10) : ""; };
  const placements = (i: number) =>
    data ? data.axes.map((a) => ({ a, s: Math.round(data!.scores[a.key]?.[i] ?? 50), note: data!.notes[i]?.[a.key] || "" }))
      .filter((x) => x.note).sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 6) : [];
  const topAxes = (i: number) =>
    data ? data.axes.map((a) => ({ n: a.name, s: Math.round(data!.scores[a.key]?.[i] ?? 50), w: !!a.weak }))
      .sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 3) : [];

  // ═══ SELECT (eid-r8t6) — the lasso gesture ═══════════════════════════════════════════════════════
  // The PATH lives here (transient view state, screen px relative to the canvas); the SET lives in the
  // model. deckmap is asked exactly one question at gesture end — "which cards are inside this path?" —
  // because only it holds the live viewport.
  //
  // Coexistence with deck, not interception: in select mode deck's own drag gestures are switched off
  // (deckmap.setSelectMode → dragPan/dragRotate false), so a one-finger drag is ours by construction and
  // we never have to swallow the event. That is what keeps two-finger PINCH-ZOOM alive on a phone: deck's
  // pinch recognizer is registered independently and still sees both pointers.
  let lasso = $state<number[][] | null>(null);
  let lassoPointer = -1;
  const canvasPt = (e: PointerEvent): number[] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function lassoDown(e: PointerEvent) {
    if (!m.selectMode || !data) return;
    if (lassoPointer >= 0) { endLasso(false); return; }   // a second finger arrived → it's a pinch, abandon the draw
    lassoPointer = e.pointerId;
    lasso = [canvasPt(e)];
    window.addEventListener("pointermove", lassoMove);
    window.addEventListener("pointerup", lassoUp);
    window.addEventListener("pointercancel", lassoUp);
  }
  function lassoMove(e: PointerEvent) {
    if (e.pointerId !== lassoPointer || !lasso) return;
    const pt = canvasPt(e), last = lasso[lasso.length - 1];
    if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 2) return;   // decimate: no 1px path spam
    lasso = [...lasso, pt];
  }
  function lassoUp(e: PointerEvent) { if (e.pointerId === lassoPointer) endLasso(true); }
  function endLasso(commit: boolean) {
    window.removeEventListener("pointermove", lassoMove);
    window.removeEventListener("pointerup", lassoUp);
    window.removeEventListener("pointercancel", lassoUp);
    const path = lasso; lasso = null; lassoPointer = -1;
    if (!commit || !path || path.length < 3 || !handle) return;
    const idx = handle.selectPolygon(path, filterMask);   // hidden cards aren't selectable — the mask rides along
    if (idx.length) { m.setSelection(idx); mintedKey = null; focusCard(null); }
  }
  // programmatic seam for the integration suite: synthesize the SAME path the pointer would have drawn
  function lassoFromPath(path: number[][]): number {
    if (!handle) return 0;
    const idx = handle.selectPolygon(path, filterMask);
    if (idx.length) { m.setSelection(idx); mintedKey = null; focusCard(null); }
    return idx.length;
  }
  // Export-menu data-out: the held set as {ids,titles,urls} JSON — cards flowing to other tools
  // (and the CLI descend verb's input shape). The selection-pane FERRY died with in-page descend;
  // this outbound export is not it coming back.
  function exportSelection() {
    if (!selection?.length || !data) return;
    const payload = { ids: selection.map((i) => data!.ids[i]), titles: selection.map((i) => data!.titles[i]), urls: selection.map((i) => data!.urls?.[i]) };
    download(JSON.stringify(payload, null, 2), exportBase() + "-selection-" + payload.ids.length + ".json", "application/json");
  }

  // ═══ DESCEND (eid-kep3) — the held set becomes its OWN map, IN PAGE: subset the carried card
  // vectors, re-discover local axes (PCA + parallel analysis), re-layout, re-name — src/engine.ts
  // descendMap through the page binding (viewer/src/ingest.ts). The child mounts through the SAME
  // in-memory path a dropped .eido takes, replacing the working document; the parent is unchanged on
  // disk and one Open away. No selection JSON, no ferry — the file never leaves the tab.
  // The key is OPTIONAL here (the cards already exist): without one the child opens honest-but-unnamed
  // (PC axis names + contrastive-term region labels).
  let descending = $state<IngestStatus | null>(null);
  let descendErr = $state("");
  const descendWhyNot = $derived.by(() => {
    if (!data) return "no map";
    if (!store?.vectors()) return "this .eido carries no card vectors — the map was emitted without them, so there is nothing honest to re-discover local axes from";
    if (!selection?.length) return "nothing held";
    if (selection.length < 2) return "descend needs at least 2 cards to discover local axes";
    return "";
  });
  async function descendSelection() {
    const D = store?.map(); const sel = selection;
    if (!D || !sel?.length || descendWhyNot || descending) return;
    descendErr = "";
    descending = { phase: "axes", label: "descending…" };
    try {
      const child = await engine.descend(D, sel.map((i) => D.ids[i]), getKey(), (s) => (descending = s));
      mountMap(child, { intro: true });   // the child IS the working document now (a Store, decoded from the worker's container bytes)
    } catch (e: any) {
      descendErr = String(e?.message ?? e);
    } finally { descending = null; }
  }

  // ═══ DERIVE (eid-8139) — an axis from EXAMPLES. With a set held, mint a scalar dimension scoring every
  // card by "how much like these": the mean-difference direction between the selection and the rest of the
  // corpus, cosined against every card vector (viewer/src/derive.ts). Identical in kind to a typed query —
  // it lands in the same registry, so every channel menu, the scrubber, honest⇄rank and the ✕ already work.
  // THE LAW: it places itself on NOTHING and does not consume the selection. The pane offers the placement.
  let deriveLabel = $state("");              // what the user typed (empty = use the selection's top term)
  let mintedKey = $state<string | null>(null);  // the dimension just minted, so the pane can offer placements
  let deriveErr = $state("");
  const deriveDefault = $derived(m.selectionTerms[0] ?? "these");
  // why the verb is unavailable, in the user's terms — an honest reason beats a dead button
  const deriveWhyNot = $derived.by(() => {
    if (!data) return "no map";
    if (!store?.vectors()) return "this .eido carries no card vectors — the map was emitted without them, so an axis can't be derived from examples";
    if (!selection?.length) return "nothing held";
    if (selection.length === data.ids.length) return "the selection is the whole corpus — there is nothing to contrast it against";
    return "";
  });
  function deriveAxis() {
    const D = data, sel = selection;
    if (!D || !sel?.length || deriveWhyNot) return;
    const V = store?.vectors();
    const dir = deriveDirection(V, sel);
    if (!dir) { deriveErr = "these cards don't point anywhere the rest of the corpus doesn't"; return; }
    deriveErr = "";
    mintedKey = m.addDerived((deriveLabel.trim() || deriveDefault), sel.map((i) => D.ids[i]), cosineAll(dir, V!));
    deriveLabel = "";
  }
  const mintedDim = $derived(mintedKey ? m.derivedDims.find((d) => d.key === mintedKey) : undefined);

  function focusCard(i: number | null) { m.selected = i; handle?.setFocus(i); }
  function reset() { focusCard(null); m.clearFilters(); m.selectMode = false; handle?.setHighlight(null); m.grain = data?.di ?? 0; handle?.resetView(); }

  // The current label for each channel button — the toolbar states the view, so nothing is hidden in a menu.
  // NOTE: "3D cloud" is an INDEPENDENT 3D embedding of the same cards, not the 2D map with depth —
  // measured on pathfinder.eido, only ~2.3 of a card's 8 nearest neighbours in 2D are still among its 8
  // nearest in 3D. Calling it "3D neighbor map" implied a continuity that does not exist. The pipeline
  // now measures that agreement per corpus (MapContract.xyzAgree) and the about pane states it
  // (eid-ovo7: seeding/sharing the fits was measured and doesn't close the gap, so it is stated instead).
  const LAYOUT_LABELS: Record<string, string> = { mde: "neighbor map", axes: "axis scatter", orbit: "3D cloud", axes3d: "3D axis scatter" };
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
  // Restore a StatePatch — the ONE apply path for both carriers of the same shape (eid-thbs): the URL
  // (parseUrl) and a saved view from the file (view.open). The model applies the eager half; App owns the
  // DOM-ish half (slider remount, async query embedding, the grain-dependent region/facet/find/card, and
  // the camera, all applied once the graph has settled).
  function applyState(p: StatePatch) {
    const prevLayout = m.layout;
    m.applyPatch(p);
    if (p.scrubbed ?? p.window !== undefined) scrubNonce++;   // remount the slider so its thumbs show the restored window
    for (const t of p.queries ?? []) embedAndAdd(t);  // best-effort, background; won't block the restore or hang the app
    // a shared SELECTION resolves first (a derived dim may reference it). Full ids (from the file) resolve
    // per-id; an encoded index set (from a URL) that doesn't checksum against this corpus drops, not fakes.
    const toIdx = (s: string[] | UrlIdSet | undefined): number[] | null =>
      s && data ? resolveIdSet(Array.isArray(s) ? { ids: s } : s, data.ids) : null;
    const selIdx = toIdx(p.selection);
    // DERIVED dims re-derive from their example ids (a label alone can't reproduce a direction), under the
    // KEY the patch names (so channels pointing at them keep pointing at the same axis) and with the label
    // it carries. Examples that don't resolve drop the axis rather than restoring a lookalike.
    for (const d of p.derived ?? []) {
      const D = data; if (!D) break;
      const idx = d.ref ? (selIdx ?? []) : (toIdx(d.ids ?? d.set) ?? []);
      const V = store?.vectors();
      const dir = deriveDirection(V, idx);
      if (dir) m.addDerived(d.label, idx.map((i) => D.ids[i]), cosineAll(dir, V!), d.key);
    }
    queueMicrotask(() => {
      if (p.region !== undefined && p.region >= 0 && p.region < curCount) togglePin(p.region);
      if (p.facet !== undefined && colorDim?.ord?.includes(p.facet)) toggleFacetPin(p.facet);
      if (p.find !== undefined) m.onFind(p.find);
      if (p.card !== undefined && data) { const i = data.ids.indexOf(p.card); if (i >= 0) focusCard(i); }
      if (selIdx?.length) m.setSelection(selIdx);   // resolved above, applied once the graph settles
      // camera LAST, after deck has consumed the (possibly new) layout. A 2D↔3D crossing runs a ~700ms
      // camera-continuity ease that would override an immediate set, so wait it out in that one case.
      const cam = p.camera;
      if (cam) {
        const crossed = p.layout !== undefined && p.layout !== prevLayout && ((p.layout === "orbit" || p.layout === "axes3d") !== (prevLayout === "orbit" || prevLayout === "axes3d"));
        if (crossed) setTimeout(() => handle?.setCamera(cam), 800);
        else requestAnimationFrame(() => handle?.setCamera(cam));
      }
    });
  }
  $effect(() => { void [m.layout, m.channels.color, m.channels.size, m.grain, m.channels.x, m.channels.y, m.channels.z, m.pinned, m.selected, m.channels.scrub, m.scrubLo, m.scrubHi, m.dimProps, m.filters, m.queries, m.derived, m.selection, m.channels.sort, m.citeOn, m.ghostsOn, m.showLabels, m.deckOpen, m.deckQ, m.deckUnread, themeName]; if (urlReady) { try { history.replaceState(history.state, "", currentUrl()); } catch {} } });
  // a hover tooltip describes a thing at the CURRENT grain — when grain shifts under the pointer,
  // the described thing is gone, and the tooltip goes with it (stale state must not linger)
  $effect(() => { void m.grain; hovered = null; });

  function applyUrlState() { applyState(parseUrl(location.search)); }

  // ═══ SAVED VIEWS (eid-thbs) — the file carries its own ways of being looked at ═══════════════════
  // `view.save` names the current view and appends it to the file's views IN MEMORY (the document is
  // now dirty — the toolbar's save shows it). `save` (eid-cawh) is the ONE persist verb: write in
  // place where a handle is held, a filename-preserving download elsewhere. `view.open` applies a
  // saved state exactly: one action.
  let viewName = $state("");
  const savedViews = $derived(data?.views ?? []);
  function currentViewState(): ViewState {
    const s = m.snapshot();
    if (handle) s.camera = handle.getCamera();   // App owns the deck handle, so App composes the camera in
    return s;
  }
  function saveView() {
    const D = store?.map(); const name = viewName.trim();
    if (!D || !name || !m.data) return;
    // ONE array, written to BOTH faces of the same map: the raw contract (what encodeContainer reads —
    // Svelte's $state proxy does NOT write through to its underlying object, verified by e2e: the first
    // cut wrote only m.data and the downloaded file carried no views) and the reactive proxy (what the
    // views list renders from).
    const views = [...(D.views ?? []), { name, created: Date.now(), state: currentViewState() }];
    D.views = views;
    m.data.views = views;
    viewName = "";
    dirty = true;   // unsaved work exists — the save button shows the dot until the file is written
  }

  // ═══ SAVE / OPEN / EXPORT — the document lifecycle (eid-cawh · eid-4ii9) ═════════════════════════
  // The saved payload IS the full re-emit: the whole contract through the shared codec, views (and the
  // work stratum they carry — selections, derived axes) included. Save is one verb; viewer/src/file.ts
  // holds the per-browser truth (FSA write-in-place on Chromium, filename-preserving download elsewhere).
  let dirty = $state(false);
  let saveNote = $state("");   // transient, honest: "saved" (in place) vs "downloaded <name>"
  let recents = $state<RecentFile[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);   // the non-FSA open fallback
  const exportBase = () => currentFileName().replace(/\.eido$/i, "") || "eidoscope";
  async function saveDoc() {
    const D = store?.map(); if (!D) return;
    const bytes = gzipSync(encodeContainer(D));   // the SAME shared codec the pipeline emits with
    const how = await writeEido(bytes);
    dirty = false;
    saveNote = how === "wrote" ? "saved" : "downloaded " + currentFileName();
    setTimeout(() => (saveNote = ""), 4000);
  }
  async function openDoc() {
    if (supportsFSA()) { const f = await openViaPicker(); if (f) await openFile(f, { named: true }); }
    else fileInput?.click();
  }
  async function openRecentDoc(r: RecentFile) {
    const f = await openRecent(r);
    if (f) await openFile(f, { named: true });
    else { loadFailed = true; status = "couldn't reopen " + r.name + " — permission declined or the file moved"; }
  }
  // ── EXPORT — one surface, every outbound flow, all fed from the cards (the shared src/export.ts) ──
  async function exportHTML() {
    const D = store?.map(); if (!D) return;
    // the shell is this very app: fetched from the host when served, the live document as the file:// fallback
    let shell = "";
    try { const r = await fetch(location.pathname); if (r.ok) shell = await r.text(); } catch {}
    if (!shell) shell = "<!doctype html>\n" + document.documentElement.outerHTML;
    download(injectEido(shell, gzipSync(encodeContainer(D))), exportBase() + ".html", "text/html");
  }
  function exportVault() {
    const D = store?.map(); if (!D) return;
    const { manifest, cards } = vaultEntries(D);
    const entries: Record<string, Uint8Array> = { [manifest.name]: strToU8(manifest.text) };
    for (const c of cards) entries[c.name] = strToU8(c.text);
    download(zipSync(entries), exportBase() + "-vault.zip", "application/zip");
  }
  function exportDeck() {
    const D = store?.map(); if (!D) return;
    download(deckJSONL(D), exportBase() + "-deck.jsonl", "application/x-ndjson");
  }
  function openView(v: SavedView) {
    m.resetViewState();   // a saved view applies EXACTLY — no residue from the view you were just in
    scrubNonce++;
    applyState(v.state);
  }
  $effect(() => { void [m.layout, m.channels.color, m.channels.size, m.grain, m.channels.x, m.channels.y, m.channels.z, m.pinned, m.selected, m.channels.scrub, m.scrubLo, m.scrubHi, m.dimProps, m.filters, m.queries, m.derived, m.selection, themeName]; if (urlReady) { try { history.replaceState(history.state, "", currentUrl()); } catch {} } });

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
  function mountMap(S: Store, opts?: { intro?: boolean }) {
    handle?.destroy();                                   // free the previous deck's GPU context before recreating
    store = S;
    const D = S.map();
    m.mount(D);                                       // per-corpus state reset + x/y/z parked on this file's axes
    status = "";
    if (opts?.intro) showIntro = true;                    // a freshly-opened file introduces itself
    const dims0 = buildDimensions(D);   // build the registry ONCE for this mount's accessors
    const ch = m.channels;
    handle = createMap(canvas, D, {
      getColor: m.colorGet(dims0, ch.color, D.levels?.[m.grain] ?? D.cluster), getRadius: m.sizeGet(dims0, ch.size), getX: m.posGet(dims0, ch.x), getY: m.posGet(dims0, ch.y), getZ: m.posGet(dims0, ch.z), posSig: m.posSig, layout: m.layout, showLabels: labelsOn, grain: m.grain, theme: themeName,
      onClick: (i) => { if (m.selectMode) return; focusCard(i < 0 ? null : i); },
      onHover: (h, x, y) => (hovered = h == null ? null : { ...h, x, y }),
      onGrainChange: (g) => m.setGrain(g),
    });
    // read-only introspection seam for the integration suite (drives the REAL built app, asserts real state)
    (window as any).__eido = () => { const d = handle?.debug(); return { grain: m.grain, k: curCount, layout: m.layout, color: m.channels.color, pin: pinned, facetPin, focus: selected, detail: selected !== null, deckOpen: m.deckOpen, deckQ: m.deckQ, deckUnread: m.deckUnread, sort: m.channels.sort, cite: m.citeOn, ghosts: m.ghostsOn, theme, themeName, pal: Array.from({ length: 6 }, (_, i) => col(i)), hover: hovered ? hovered.kind : null, zoom: d?.zoom ?? 0, labels: d?.labels ?? 0, labelsOn, regions: d?.regions ?? 0, rot: d?.rot ?? null, rotX: d?.rotX ?? null, target: d?.target ?? null, span3: d?.span3 ?? null, filters: chips.map((c) => c.label), filterCounts: chips.map((c) => c.n), selectMode: m.selectMode, selection: selection?.length ?? 0, selShareable: m.selShareable, derived: m.derivedDims.length, dims: m.allDims.map((x) => x.key), views: (m.data?.views ?? []).length, drawing: !!lasso, visible: visibleCount, dirty, file: currentFileName(), inPlace: canWriteInPlace() }; };
    // the map no longer fills the window (a toolbar sits above it), so both seams speak PAGE coordinates —
    // what a test's mouse/touch actually uses — and convert at the canvas edge.
    const rect = () => canvas.getBoundingClientRect();
    (window as any).__eidoProject = (xy: number[]) => { const p = handle?.project(xy); if (!p) return p; const r = rect(); return [p[0] + r.left, p[1] + r.top]; };
    (window as any).__eidoPick = (x: number, y: number) => { const r = rect(); return handle?.pickAt(x - r.left, y - r.top); };
    // SELECT seam: hand in a page-coordinate path, get back how many cards it caught (the same call the
    // real pointerup makes, through the same viewport projection + polygon test).
    // [screenX, screenY, ndcZ] for a card, in PAGE coords — the guard's evidence surface.
    (window as any).__eidoProjectIndex = (i: number) => { const q = handle?.projectIndex(i); if (!q) return null; const r = rect(); return [q[0] + r.left, q[1] + r.top, q[2]]; };
    // the colour a card is PAINTED, through the very accessor the deck layer uses — so a test can assert
    // "placing this dimension on colour actually repainted the map", not merely "a menu label changed".
    (window as any).__eidoColor = (i: number) => m.colorGet(m.allDims, m.channels.color, m.assignment)(i);
    (window as any).__eidoLasso = (path: number[][]) => { const r = rect(); return lassoFromPath(path.map(([x, y]) => [x - r.left, y - r.top])); };
  }
  // Semantic query: embed in-browser (same model that made the card vectors), cosine-rank, and append a
  // query-kind DIMENSION. It then appears in every channel menu (color/size/x/y/z/scrubber/deck-sort) like any
  // other dimension — no bespoke plumbing. N queries coexist. To hide low-similarity cards, put the query on the scrubber.
  // embed a text query → append a query-kind dimension; returns its key (or null). It does NOT touch any channel:
  // making an axis and placing it are separate acts (the user decides where it goes), so nothing moves underneath.
  async function embedAndAdd(q: string): Promise<string | null> {
    const D = data, V = store?.vectors(); if (!D || !V || !q) return null;
    querying = true; queryErr = ""; queryStatus = "loading model…"; queryPct = null;
    // The first query lazy-loads a ~23MB model from a CDN. Show live progress, and detect a genuine STALL (no
    // progress for a while) vs. merely-slow — so a throttled/hung download surfaces a retry instead of freezing.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let onStall!: (e: Error) => void;
    const stalled = new Promise<never>((_, rej) => (onStall = rej));
    const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => onStall(new Error("__stall__")), 40000); };
    armStall();
    try {
      const qp = engine.embedQuery(q, (D as any).derivedBy?.embedder?.id, (p) => { queryStatus = p.label; queryPct = p.pct ?? null; armStall(); });
      qp.catch(() => {});   // if the race is lost to the stall, the reset-terminated promise must not surface as an unhandled rejection
      const qv = await Promise.race([qp, stalled]);
      const key = m.addQuery(q, cosineAll(qv, V));
      queryStatus = "";
      // M-D1: the fresh axis presents ITSELF — its chip scrolls into view and takes focus, the way any new
      // object announces itself by simply being there (no explanatory sentence).
      queueMicrotask(() => { const el = document.querySelector<HTMLElement>(`[data-minted="${key}"]`); el?.scrollIntoView({ block: "nearest" }); el?.focus(); });
      return key;
    } catch (e: any) {
      engine.resetEmbedder();   // drop the worker's poisoned/half-loaded model so the next add retries cleanly
      queryErr = e?.message === "__stall__"
        ? "model download stalled — check your connection, then press add to retry"
        : "couldn’t run the query (" + String(e?.message ?? e) + ") — press add to retry";
      queryStatus = "";
      return null;
    } finally { clearTimeout(stallTimer); querying = false; }
  }
  async function runQuery() { const q = semQuery.trim(); if (!q) return; semQuery = ""; await embedAndAdd(q); }
  // `named: true` means file.ts already recorded the source (picker/recent — it holds the handle);
  // the drop/input paths record it here, handle-less (or with the Chromium drop handle, below).
  async function openFile(file: File, opts?: { named?: boolean }) {
    try {
      status = "opening " + file.name + "…"; loadFailed = false;
      if (!opts?.named) setSource(file.name);
      mountMap(await decodeEido(new Uint8Array(await file.arrayBuffer())), { intro: true });
      noMap = false;
      dirty = false;
      void listRecents().then((r) => (recents = r));   // a picker/drop-with-handle open just added one
    } catch (e: any) { loadFailed = true; status = "couldn't open " + file.name + " — " + (e?.message ?? e); }
  }

  // ═══ INGEST (eid-bacg) — folder → map, in the tab. The app is a general corpus opener: a dropped or
  // picked FOLDER of .md/.txt runs the same engine the CLI runs (src/engine.ts), in-page; a dropped
  // .eido opens as before. `noMap` is the EMPTY STATE: no bundled map answered — the open panel is the
  // app's front door, not an error.
  let noMap = $state(false);           // true → show the open-a-corpus panel (empty state)
  let noMapHint = $state("");          // why there is no map yet (a fetch error, subdued — not a failure)
  let ingest = $state<{ files: IngestFile[]; name: string; source?: string } | null>(null);
  // hfOpen: the HuggingFace connector's dialog (connectors/HuggingFace.svelte). Any connector ends
  // the same way — a CorpusPayload fed to startIngest, into the one Ingest panel.
  let hfOpen = $state(false);
  let folderInput: HTMLInputElement | undefined = $state(); // the ONE folder doorway (eid-9rdy)
  function startIngest(files: IngestFile[], name: string, source?: string) {
    if (!files.length) { noMapHint = "no .md/.txt files in that folder"; return; }
    ingest = { files, name, source };
  }
  function connectorReady(p: CorpusPayload) { hfOpen = false; startIngest(p.files, p.name, p.source); }
  async function pickFolder(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = input.files; if (!list?.length) return;
    const name = ((list[0] as any).webkitRelativePath || "").split("/")[0] || "folder";
    startIngest(await filesFromFileList(list), name);
    input.value = "";
  }
  function ingestDone(store: Store) {
    ingest = null; noMap = false; status = "";
    // the SAME in-memory path a dropped .eido takes — the map opens as the working document; Save
    // produces the .eido through the shared codec (the worker already handed us codec bytes).
    mountMap(store, { intro: true });
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault(); dragOver = false;
    const dt = e.dataTransfer; if (!dt) return;
    const f = dt.files?.[0];
    if (f && /\.eido$/i.test(f.name) && dt.files.length === 1) {
      // Chromium hands a real file handle for a DROPPED file too — keep it, so Save writes in place even
      // when the file arrived by drag. Best-effort and async; the open itself never waits on it.
      const item = dt.items?.[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<any> }) | undefined;
      item?.getAsFileSystemHandle?.().then((h) => { if (h?.kind === "file") setSource(f.name, h); }).catch(() => {});
      openFile(f); return;
    }
    // a folder (or a handful of .md/.txt) dropped → ingest it
    const first = (dt.items?.[0] as any)?.webkitGetAsEntry?.();
    const name = first?.isDirectory ? first.name : "dropped files";
    const files = await filesFromDataTransfer(dt);
    if (files.length) startIngest(files, name);
  }
  function onFileInput(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = "";
    if (f) openFile(f);
  }

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
    void listRecents().then((r) => (recents = r));   // offered on the empty state; refreshed on open
    (async () => {
      try {
        const url = mapUrl();
        const S = await loadMap(url);
        // name the document after what was actually opened (?map=/./map.eido basename) — Save preserves it
        setSource(decodeURIComponent(url.split("/").pop() || "map.eido").replace(/\?.*$/, ""));
        try { showIntro = !localStorage.getItem("eido-seen"); } catch { showIntro = true; }
        mountMap(S);
        applyUrlState(); urlReady = true;  // restore any deep-linked view/card, then start mirroring state → URL
      } catch (e: any) {
        // no bundled/hosted map answered → the EMPTY STATE: the app opens corpora, it doesn't apologize
        status = ""; noMap = true; urlReady = true;
        noMapHint = String(e?.message ?? e);
      }
    })();
    // Escape closes the topmost OVERLAY — but a toolbar menu is not an overlay: Bits UI already closes it on
    // Escape, and letting the same key also pop history would yank the view out from under a menu dismissal.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      // expert keyboard routes (M-A3 / M-A5) — single keys consistent with `s`, skipped while typing, while
      // a menu is open (its own arrow/letter navigation wins), or under a modal overlay.
      const plain = !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('[data-menu][data-state="open"]') && !showIntro && !m.deckOpen && !sheetOpen;
      if (plain) {
        if (e.key === "s") { m.toggleSelectMode(); return; }
        if (e.key === "l") { if (m.channels.color === "region") m.showLabels = !m.showLabels; return; }
        if (e.key === "d") { m.deckOpen = true; return; }
        if (e.key === "r") { reset(); return; }
        // camera: arrows pan, +/- zoom, shift+arrows orbit in 3D — hold-to-repeat via native key repeat
        if (e.key.startsWith("Arrow")) {
          e.preventDefault();
          const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          const dy = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
          if (e.shiftKey) handle?.orbitBy(dx * 5, -dy * 5);
          else handle?.panBy(dx * 48, dy * 48);
          return;
        }
        if (e.key === "+" || e.key === "=") { handle?.zoomBy(0.25); return; }
        if (e.key === "-" || e.key === "_") { handle?.zoomBy(-0.25); return; }
      }
      if (e.key !== "Escape") return;
      if (document.querySelector('[data-menu][data-state="open"]')) return;
      // Escape leaves the lasso before it touches the overlay stack — the mode you're IN is what you meant.
      if (m.selectMode) { endLasso(false); m.selectMode = false; return; }
      requestClose();
    };
    const onPop = () => { overlayPushed = false; doCloseOverlays(); };  // Back / mobile back gesture closes the overlay
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => { handle?.destroy(); window.removeEventListener("keydown", onKey); window.removeEventListener("popstate", onPop); };
  });

  $effect(() => {
    const l = m.layout, c = m.channels.color, s = m.channels.size, xk = m.channels.x, yk = m.channels.y, zk = m.channels.z, sl = labelsOn, g = m.grain, a = assignment, co = m.citeOn, go = m.ghostsOn, th = themeName, h = handle, d = data, ad = allDims, dp = m.dimProps, ps = m.posSig;
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
  // the window's readout lives in the model (one formatter for the toolbar, the popover AND the chip)
  const scrubText = $derived(m.scrubText);
  $effect(() => { m.ensureScrubKey(); });
  $effect(() => { const h = handle, mask = filterMask; if (h) h.setFilterMask(mask); });
  // selection + select-mode are pushed the same way the mask is: pure derived reads, no write-back.
  $effect(() => { const h = handle, sel = selection; if (h) h.setSelection(sel); });
  $effect(() => { const h = handle, sm = selectMode; if (h) h.setSelectMode(sm); });  // push the mask (pure derived → no write-loop)

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
  const sidebarOpen = $derived(!!data && (selected !== null || selection !== null || pinnedRegion !== null));
</script>

{#snippet propItems(d: Dimension | undefined)}
  {#if d && (d.kind === "scalar" || d.kind === "temporal")}
    {@const p = propsOf(d)}
    <li class="menu-title text-[10px] tracking-widest uppercase">scale</li>
    <!-- discovered axes are rank-normalized positions by design (even, readable spread); norm isn't a
         user choice there, so only metrics/queries get the honest⇄rank toggle. invert applies to all. -->
    {#if !d.fixedNorm}
      <li><button onclick={() => setProp(d, { norm: "honest" })} aria-label="honest magnitudes" aria-pressed={p.norm === "honest"}><span class="w-3">{p.norm === "honest" ? "✓" : ""}</span> honest magnitudes <span class="ml-auto text-xs opacity-50">the skew shows</span></button></li>
      <li><button onclick={() => setProp(d, { norm: "rank" })} aria-label="rank-normalized" aria-pressed={p.norm === "rank"}><span class="w-3">{p.norm === "rank" ? "✓" : ""}</span> rank-normalized <span class="ml-auto text-xs opacity-50">even spread</span></button></li>
    {/if}
    <li><button onclick={() => setProp(d, { invert: !p.invert })} aria-label="invert direction" aria-pressed={p.invert}><span class="w-3">{p.invert ? "✓" : ""}</span> invert direction <span class="ml-auto text-xs opacity-50">high ↔ low</span></button></li>
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
            <!-- the 3D cloud is an INDEPENDENT UMAP fit, not the map with depth (eid-ovo7) — say so, with
                 the per-corpus measured neighbor agreement when the file carries it, so the difference
                 between the two layouts is a number the reader can weigh, not a vibe. -->
            <div><span class="font-bold">3D cloud</span> — <span class="opacity-75">an independent 3D embedding of the same card vectors, not the neighbor map with depth added — the two layouts arrange the cards differently{#if data.xyzAgree != null}: on this corpus, {data.xyzAgree.toFixed(1)} of a card's 8 nearest neighbors on the map are still among its 8 nearest in the cloud{/if}.</span></div>
            <div><span class="font-bold">axes</span> — <span class="opacity-75">PCA of the full-text embeddings. A card's place on an axis is its exact projection, so an axis position IS a number you can compare.</span></div>
            <div><span class="font-bold">regions</span> — <span class="opacity-75">clusters of the same vectors, named by a model from what each group over-uses. The grain slider walks {nLevels} nested levels, from {data.counts?.[0] ?? data.k} to {data.counts?.[data.counts.length - 1] ?? data.k} regions, ×{GRAIN_RATIO} per notch — a slider pragmatic, since the corpus clumps at every scale and prefers none (measured; no level is more "real"). The top is where splitting would cut regions below {GRAIN_MIN_REGION} cards; the default is the finest level that still fits the {GRAIN_PALETTE_N}-colour palette.</span></div>
          </div>

          <div class="mt-3 border-t border-base-300 pt-2">
            <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">strength</div>
            <div class="text-[11px] leading-snug opacity-75">
              {axStats.n} axes · {Math.round(axStats.variance * 100)}% of variance{#if axStats.weak} · {axStats.weak} under 2%{/if}
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

          <!-- SAVED VIEWS (eid-thbs): the file's own ways of being looked at. Open applies one exactly;
               save appends the current view and downloads the updated .eido (the browser can't write in
               place — the download is the save). -->
          <div class="mt-3 border-t border-base-300 pt-2" data-views>
            <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">views</div>
            {#each savedViews as v, i}
              <div class="flex items-center gap-1 py-0.5 text-[11px]">
                <span class="min-w-0 flex-1 truncate" title={v.name}>{v.name}</span>
                <span class="flex-none font-mono text-[10px] opacity-50">{provDate(v.created)}</span>
                <button data-testid="{scope}:view-open-{i}" class="btn btn-ghost btn-xs normal-case" onclick={() => openView(v)}>open</button>
              </div>
            {:else}
              <div class="text-[11px] opacity-60">no saved views in this file yet</div>
            {/each}
            <div class="mt-1 flex gap-1">
              <input data-testid="{scope}:view-name" bind:value={viewName} placeholder="name this view…" aria-label="name the current view" class="input input-xs min-w-0 flex-1" onkeydown={(e) => e.key === "Enter" && saveView()} />
              <button data-testid="{scope}:view-save" class="btn btn-xs btn-primary flex-none normal-case" disabled={!viewName.trim()}
                onclick={saveView}>save view</button>
            </div>
            <div class="mt-1 text-[10px] leading-snug opacity-50">a saved view lives in the file — press save in the toolbar to write it (● marks unsaved work)</div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
{/snippet}

{#snippet controls(scope: string)}
  <!-- SELECT — a mode, not a menu: it changes what a drag on the map MEANS. While it is on, deck's own
       drag is off and the pointer draws a lasso; pinch-zoom keeps working. Keyboard: s / Escape. -->
  <button data-testid="{scope}:select" data-fold="0" aria-pressed={selectMode}
    class="btn btn-sm flex-none gap-1 normal-case {selectMode ? 'btn-active btn-primary' : 'btn-ghost'}"
    onclick={() => m.toggleSelectMode()}>
    <span aria-hidden="true">◌</span><span class="font-medium">select</span>
    {#if selection}<span class="badge badge-xs badge-primary">{selection.length}</span>{/if}
  </button>

  <!-- LAYOUT — plus the two map-render overlays, which are layout-ish rather than encoding-ish -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-fold="0" data-menu="{scope}:layout" aria-label="layout">
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
          {#if hasCite}<DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:overlay:cite" role="menuitemcheckbox" aria-checked={m.citeOn} onSelect={() => (m.citeOn = !m.citeOn)}><span class="w-3">{m.citeOn ? "✓" : ""}</span>cite edges</DropdownMenu.Item>{/if}
          {#if hasGhosts}<DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:overlay:ghosts" role="menuitemcheckbox" aria-checked={m.ghostsOn} onSelect={() => (m.ghostsOn = !m.ghostsOn)}><span class="w-3">{m.ghostsOn ? "✓" : ""}</span>frontier</DropdownMenu.Item>{/if}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>

  <!-- AXES — only meaningful in the scatter layouts; x/y/z with each dimension's own scale controls -->
  {#if m.layout === "axes" || m.layout === "axes3d"}
    <Popover.Root>
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 1)}" data-fold="1" data-menu="{scope}:axes" aria-label="axes">
        <span class="opacity-60">axes</span><span class="max-w-[10rem] truncate font-medium">{xDim?.name ?? "—"} × {yDim?.name ?? "—"}</span><span class="text-[9px] opacity-50">▾</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="start">
          {#each [{ ch: "x" as const, d: xDim }, { ch: "y" as const, d: yDim }, ...(m.layout === "axes3d" ? [{ ch: "z" as const, d: zDim }] : [])] as ax}
            <div class="mb-2">
              <div class="mb-1 flex items-center gap-2">
                <span class="w-4 flex-none font-mono text-[10px] uppercase opacity-60">{ax.ch}</span>
                <select bind:value={m.channels[ax.ch]} data-axis={scope + ":" + ax.ch} aria-label="{ax.ch} axis" class="select select-xs min-w-0 flex-1">
                  {#each scalarDims as d}<option value={d.key}>{d.name}{dimTag(d)}</option>{/each}
                </select>
              </div>
              {#if ax.d && !ax.d.fixedNorm}
                {@const p = propsOf(ax.d)}
                <div class="ml-6 flex gap-1">
                  <!-- honest⇄rank as a fixed-width symbol toggle (eid-kzv2 item 6) — like ☾/☀: the glyph shows the
                       current state, clicking flips it, and the button never changes width. -->
                  <button class="btn btn-xs btn-ghost btn-square font-mono" aria-pressed={p.norm === "rank"}
                    aria-label="{ax.ch} axis: {p.norm === 'honest' ? 'honest magnitudes' : 'rank-normalized'} — click to switch"
                    onclick={() => setProp(ax.d!, { norm: p.norm === "honest" ? "rank" : "honest" })}>{p.norm === "honest" ? "▁▁█" : "▃▅▇"}</button>
                  <button class="btn btn-xs {p.invert ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.invert} aria-label="{ax.ch} axis: invert direction" onclick={() => setProp(ax.d!, { invert: !p.invert })}>invert</button>
                </div>
              {:else if ax.d}
                {@const p = propsOf(ax.d)}
                <div class="ml-6 flex gap-1"><button class="btn btn-xs {p.invert ? 'btn-active' : 'btn-ghost'}" aria-pressed={p.invert} aria-label="{ax.ch} axis: invert direction" onclick={() => setProp(ax.d!, { invert: !p.invert })}>invert</button></div>
              {/if}
            </div>
          {/each}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}

  <!-- COLOR — the picker AND the legend in one surface: what the colours mean, clickable to isolate,
       above the divider; the other lenses below it; the lens's own scale controls at the bottom. -->
  <Popover.Root>
    <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 4)}" data-fold="4" data-menu="{scope}:color" aria-label="color">
      <span class="opacity-60">color</span>
      <span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{m.channels.color === 'region' ? rgb(colOf(0)) : colorDim?.kind === 'categorical' ? rgb(colOf(0)) : rgb(rampOf?.(1) ?? colOf(0))}"></span>
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
            <li class="flex flex-row items-center gap-2 px-3 py-1 text-sm"><span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{rgb(rampOf?.(0) ?? colOf(0))}"></span><span class="truncate">{cp[0]}</span></li>
            <li class="flex flex-row items-center gap-2 px-3 py-1 text-sm"><span class="h-2.5 w-2.5 flex-none rounded-xs" style="background:{rgb(rampOf?.(1) ?? colOf(0))}"></span><span class="truncate">{cp[1]}</span></li>
          {/if}
        </ul>
        <div class="thin-sb max-h-56 flex-none overflow-y-auto border-t border-base-300">
          <ul class="menu menu-sm w-full p-1">
            <li class="menu-title text-[10px] tracking-widest uppercase">color by</li>
            <li><button data-opt="{scope}:color:region" aria-pressed={m.channels.color === "region"} onclick={() => (m.channels.color = "region")}><span class="w-3">{m.channels.color === "region" ? "✓" : ""}</span>region</button></li>
            <!-- M-A4: isolate is a CORPUS command, so every categorical dimension carries its own value
                 list here — isolation no longer requires putting the dimension on colour first. -->
            {#each catDims as d}
              <li class="flex flex-row items-center gap-0">
                {#if d.wide}
                  <!-- too many values for colour to say anything (eid-ml88) — the dimension is still
                       here to ISOLATE by, and still available on sort/find/window; colour just declines -->
                  <span class="min-w-0 flex-1 px-3 py-1.5 text-sm opacity-50" data-wide="{scope}:{d.key}"><span class="w-3 inline-block"></span><span class="truncate">{d.name}</span> <span class="font-mono text-[10px]">· {d.ord?.length} values, too many to colour</span></span>
                {:else}
                  <button class="min-w-0 flex-1" data-opt="{scope}:color:{d.key}" aria-pressed={m.channels.color === d.key} onclick={() => (m.channels.color = d.key)}><span class="w-3">{m.channels.color === d.key ? "✓" : ""}</span><span class="truncate">{d.name}</span></button>
                {/if}
                <button class="flex-none px-2" data-iso="{scope}:{d.key}" aria-expanded={isoOpen === d.key} aria-label="isolate a {d.name} value" onclick={() => (isoOpen = isoOpen === d.key ? null : d.key)}><span class="text-[9px] opacity-60">{isoOpen === d.key ? "▴" : "▾"}</span></button>
              </li>
              {#if isoOpen === d.key}
                {#each d.ord!.slice(0, 16) as v}
                  {@render legendRow(rgb(colOf(d.idx![v])), v, d.cnt![v], m.facetPinOf(d.key) === v, "isolate " + d.name + " " + v, () => applyCamera(m.toggleFacet(d.key, v)))}
                {/each}
                {#if d.ord!.length > 16}<li class="px-3 py-1 text-xs opacity-60">+{d.ord!.length - 16} more</li>{/if}
              {/if}
            {/each}
            {#each scalarDims as d}<li><button data-opt="{scope}:color:{d.key}" aria-pressed={m.channels.color === d.key} onclick={() => (m.channels.color = d.key)}><span class="w-3">{m.channels.color === d.key ? "✓" : ""}</span><span class="truncate {d.weak ? 'opacity-50' : ''}">{d.name}</span>{#if d.variance != null}<span class="ml-auto flex-none font-mono text-[10px] opacity-50">{pctOf(d.variance)}</span>{/if}</button></li>{/each}
            {@render propItems(colorDim)}
          </ul>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>

  <!-- GRAIN — a parameter of the REGION DIMENSION (which level of the cluster hierarchy is active), not of
       any channel: regions drive labels, drill, isolate and the legend whatever colour shows, so their
       resolution is a first-class, always-visible control. It briefly lived inside the colour popover —
       that conflated "where regions are displayed" with "what regions are". -->
  {#if nLevels > 1}
    <label class="flex flex-none items-center gap-1.5 px-1 text-xs {foldCls(scope, 4)}" data-fold="4">
      <span class="flex-none font-mono text-[10px] uppercase opacity-60">grain</span>
      <input type="range" data-testid="grain" min="0" max={nLevels - 1} value={m.grain} oninput={(e) => m.setGrain(+(e.currentTarget as HTMLInputElement).value)} class="range range-xs w-20 min-w-0" aria-label="grain level: how finely the map is divided into regions" aria-valuetext="{curCount} regions" />
      <span class="w-6 flex-none text-right font-mono text-[10px] opacity-60">{curCount}</span>
    </label>
  {/if}

  <!-- SIZE -->
  <Popover.Root>
    <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 1)}" data-fold="1" data-menu="{scope}:size" aria-label="size">
      <span class="opacity-60">size</span><span class="max-w-[8rem] truncate font-medium">{sizeLabel}</span><span class="text-[9px] opacity-50">▾</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="eido-pop thin-sb max-h-[min(28rem,70vh)] w-60 overflow-y-auto p-0" sideOffset={6} align="start">
        <ul class="menu menu-sm w-full p-1">
          <li class="menu-title text-[10px] tracking-widest uppercase">size by</li>
          <li><button data-opt="{scope}:size:uniform" aria-pressed={m.channels.size === "uniform"} onclick={() => (m.channels.size = "uniform")}><span class="w-3">{m.channels.size === "uniform" ? "✓" : ""}</span>uniform</button></li>
          {#each allDims.filter((d) => d.kind === "scalar") as d}
            <li><button data-opt="{scope}:size:{d.key}" aria-pressed={m.channels.size === d.key} onclick={() => (m.channels.size = d.key)}><span class="w-3">{m.channels.size === d.key ? "✓" : ""}</span><span class="truncate {d.weak ? 'opacity-50' : ''}">{d.name}</span>{#if d.variance != null}<span class="ml-auto flex-none font-mono text-[10px] opacity-50">{pctOf(d.variance)}</span>{/if}</button></li>
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
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 1)}" data-fold="1" data-menu="{scope}:window" aria-label="window a dimension — currently {scrubField.name}">
        <span class="opacity-60">window</span><span class="max-w-[6rem] truncate">{scrubField.name}</span><span class="max-w-[10rem] truncate font-mono text-xs">{scrubText}</span><span class="text-[9px] opacity-50">▾</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="start">
          <div class="mb-2 flex items-center gap-2">
            <span class="flex-none font-mono text-[10px] uppercase opacity-60">window</span>
            <select bind:value={m.channels.scrub} onchange={resetScrub} data-testid="scrub-field" aria-label="which dimension the scrubber windows" class="select select-xs min-w-0 flex-1">
              {#each scrubFields as f}<option value={f.key}>{f.name}{dimTag(f)}</option>{/each}
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
            <button class="btn btn-ghost btn-xs" onclick={resetScrub} aria-label="clear the {scrubField.name} window">clear</button>
          </div>
          {@render propItems(scrubField)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}

  <!-- FIND — substring over title/body, mirrored into the filter chips -->
  <label class="input input-sm w-40 flex-none gap-1 {foldCls(scope, 1)}" data-fold="1">
    <span class="opacity-50">⌕</span>
    <input type="search" value={m.query} oninput={(e) => m.onFind(e.currentTarget.value)} placeholder="find a card…" aria-label="find a card" class="min-w-0 grow" />
  </label>

  <!-- + AXIS — embed a question into a first-class dimension (an axis) you can place on any channel -->
  {#if store?.vectors()}
    <Popover.Root>
      <Popover.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 1)}" data-fold="1" data-menu="{scope}:axis" aria-label="add an axis from a question">
        <span class="font-medium">+ axis</span>
        <!-- M-D1: the 23MB cold-start must SHOW even when the popover is closed (a URL-restored query embeds
             in the background) — the trigger itself carries the working signal, in the app's own affordance style -->
        {#if querying}<span class="loading loading-spinner loading-xs text-primary" aria-label="embedding the question"></span>{/if}
        {#if mintedDims.length}<span class="badge badge-xs badge-primary">{mintedDims.length}</span>{/if}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="eido-pop w-80 p-3" sideOffset={6} align="end">
          <div class="mb-1 font-mono text-[10px] uppercase tracking-widest opacity-60">axis from a question</div>
          <div class="flex gap-1">
            <input bind:value={semQuery} onkeydown={(e) => e.key === "Enter" && runQuery()} placeholder="e.g. arguments about scaling" aria-label="the question this axis measures" disabled={querying} class="input input-sm min-w-0 flex-1" />
            <button onclick={runQuery} disabled={querying || !semQuery.trim()} aria-label="add this axis" class="btn btn-sm btn-primary flex-none normal-case">{querying ? "…" : "add"}</button>
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
          {#each mintedDims as qd}
            <div data-minted={qd.key} tabindex="-1" class="rounded-field mt-2 flex items-center gap-1 bg-base-200 px-2 py-1 text-[11px]">
              <span class="min-w-0 flex-1 truncate font-mono opacity-80" title={qd.name}>{qd.name}</span>
              <button onclick={() => (m.channels.color = qd.key)} title="colour by this axis" aria-label="colour by this axis" class="btn btn-ghost btn-xs">●</button>
              <button onclick={() => { m.removeDimension(qd.key); if (mintedKey === qd.key) mintedKey = null; }} title="remove this axis" aria-label="remove this axis" class="btn btn-ghost btn-xs">✕</button>
            </div>
          {/each}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
{/snippet}

{#snippet rightControls(scope: string)}
  <!-- ═══ THE DOCUMENT VERBS (eid-cawh · eid-4ii9): open · save · export. Save never folds — it is the
       one verb the document always answers to, and its dot is the unsaved-work affordance. ═══ -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 2)}" data-fold="2" data-menu="{scope}:open" aria-label="open a .eido file">
      open<span class="text-[9px] opacity-50">▾</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="eido-pop menu w-64 p-1" sideOffset={6} align="end">
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:open:file" onSelect={openDoc}>open a .eido…</DropdownMenu.Item>
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:open:folder" onSelect={() => folderInput?.click()}>open a folder of .md / .txt…</DropdownMenu.Item>
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:open:hf" onSelect={() => (hfOpen = true)}>map a HuggingFace dataset…</DropdownMenu.Item>
        {#if recents.length}
          <DropdownMenu.Separator class="my-1 h-px bg-base-300" />
          <div class="px-3 py-1 font-mono text-[10px] uppercase tracking-widest opacity-50">recent</div>
          {#each recents as r, i}
            <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:open:recent-{i}" onSelect={() => openRecentDoc(r)}>
              <span class="min-w-0 flex-1 truncate">{r.name}</span><span class="flex-none font-mono text-[10px] opacity-50">{provDate(r.opened)}</span>
            </DropdownMenu.Item>
          {/each}
        {/if}
        <div class="px-3 py-1 text-[10px] leading-snug opacity-50">…or drop a .eido anywhere on the map</div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case {foldCls(scope, 2)}" data-fold="2" data-menu="{scope}:export" aria-label="export this map">
      export<span class="text-[9px] opacity-50">▾</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="eido-pop menu w-72 p-1" sideOffset={6} align="end">
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:export:html" onSelect={exportHTML}>
          <span class="flex-1">single file</span><span class="font-mono text-[10px] opacity-50">.html — app + map, works anywhere</span>
        </DropdownMenu.Item>
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:export:vault" onSelect={exportVault}>
          <span class="flex-1">markdown vault</span><span class="font-mono text-[10px] opacity-50">.zip — one .md per card</span>
        </DropdownMenu.Item>
        <DropdownMenu.Item class="rounded-field flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-base-200" data-opt="{scope}:export:deck" onSelect={exportDeck}>
          <span class="flex-1">deck</span><span class="font-mono text-[10px] opacity-50">.jsonl — one card per line</span>
        </DropdownMenu.Item>
        <DropdownMenu.Item class="rounded-field flex items-center gap-2 px-3 py-1.5 text-sm {selection ? 'cursor-pointer hover:bg-base-200' : 'pointer-events-none opacity-40'}" data-opt="{scope}:export:selection" onSelect={exportSelection}>
          <span class="flex-1">selection</span><span class="font-mono text-[10px] opacity-50">{selection ? `.json — the ${selection.length} held cards` : "nothing held — circle cards first"}</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
  <button data-testid="{scope}:save" data-fold="0" class="btn btn-sm flex-none gap-1 normal-case {dirty ? 'btn-primary' : 'btn-ghost'}" onclick={saveDoc}
    aria-label={dirty ? "save — there is unsaved work" : "save"} title={canWriteInPlace() ? "save — writes " + currentFileName() + " in place" : "save — downloads " + currentFileName()}>
    save{#if dirty}<span aria-hidden="true" class="text-[9px] leading-none">●</span>{/if}
  </button>
  {#if saveNote}<span data-save-note class="flex-none font-mono text-[10px] opacity-60">{saveNote}</span>{/if}
  <button class="btn btn-sm btn-ghost flex-none normal-case {foldCls(scope, 3)}" data-fold="3" onclick={() => (m.deckOpen = true)}>deck</button>
  <!-- labels are a property of the region lens; off it the button would be meaningless, so it is
       presence-gated (the codebase's pattern for missing preconditions) rather than disabled-with-a-why -->
  {#if m.channels.color === "region"}
    <button aria-pressed={labelsOn} data-fold="1" class="btn btn-sm flex-none normal-case {foldCls(scope, 1)} {labelsOn ? 'btn-active' : 'btn-ghost'}" onclick={() => (m.showLabels = !m.showLabels)} aria-label="toggle labels">labels</button>
  {/if}
  <button class="btn btn-sm btn-ghost btn-square flex-none" onclick={toggleTheme} aria-label="toggle light or dark theme" title="toggle light or dark theme">{theme === "dark" ? "☾" : "☀"}</button>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="btn btn-sm btn-ghost flex-none gap-1 normal-case" data-menu="{scope}:theme" aria-label="pick a colour theme" title="pick a colour theme">
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
  <button class="btn btn-sm btn-ghost flex-none normal-case {foldCls(scope, 2)}" data-fold="2" onclick={reset}>reset view</button>
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
      <!-- desktop: one dense row of labelled menus. PRIORITY COLLAPSE (eid-ef7e): the row is measured
           (use:foldWatch) and lower-priority controls fold into the mobile controls sheet rather than
           ever clipping mid-glyph — the strip shows a whole control or none of it. -->
      <div use:foldWatch class="relative hidden items-center gap-1 px-2 py-1.5 sm:flex">
        <div data-fold-fixed class="flex min-w-0 max-w-[16rem] flex-none items-center gap-2 pr-1">
          <span class="flex-none text-base leading-none">🔭</span>
          <div class="min-w-0">{@render about("bar")}</div>
        </div>
        <div data-fold-fixed class="divider divider-horizontal mx-0 flex-none"></div>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          {@render controls("bar")}
        </div>
        <div class="flex flex-none items-center gap-1 pl-1">
          {@render rightControls("bar")}
          <!-- the fold trigger — the SAME affordance mobile uses, opening the SAME sheet -->
          <button data-fold-trigger data-menu="bar:controls" class="btn btn-sm btn-ghost flex-none normal-case {fold === 0 ? FOLDED : ''}"
            onclick={() => (sheetOpen = true)} aria-label="open the folded controls" title="more controls — the ones the narrow window folded away">controls ▴</button>
        </div>
      </div>

      <!-- mobile: name + a controls button that opens the same contents as a sheet -->
      <div class="flex items-center gap-1 px-2 py-1.5 sm:hidden">
        <div class="min-w-0 flex-1">{@render about("m")}</div>
        <button class="btn btn-sm btn-ghost flex-none normal-case" data-menu="sheet:open" onclick={() => (sheetOpen = true)} aria-label="open controls">controls ▴</button>
        <button class="btn btn-sm btn-ghost flex-none normal-case" onclick={() => (m.deckOpen = true)}>deck</button>
      </div>

      <!-- ═══ FILTER CHIPS + SCOPE — the most prominent state display on screen. The `N / M cards`
           readout is ALWAYS here (M-C1): the corpus scope lives in one consistent place whether or not
           a filter is active. Each chip carries its own match count (M-C2). ═══ -->
      <div class="flex flex-wrap items-center gap-1 border-t border-base-300 px-2 py-1.5">
        {#if chips.length}<span class="font-mono text-[10px] uppercase tracking-widest opacity-50">filters</span>{/if}
        {#each chips as chip}
          <button onclick={chip.remove} title="remove filter {chip.label}" aria-label="remove filter {chip.label}" class="badge badge-sm badge-neutral gap-1 font-mono">
            <span class="max-w-[11rem] truncate">{chip.label}</span><span class="opacity-60">· {chip.n}</span><span class="opacity-60">✕</span>
          </button>
        {/each}
        {#if chips.length > 1}<button onclick={() => m.clearFilters()} aria-label="clear all filters" class="btn btn-ghost btn-xs normal-case">clear all filters</button>{/if}
        <span data-scope class="ml-auto font-mono text-[10px] opacity-60">{visibleCount} / {data.ids.length} cards</span>
      </div>
    </header>
  {/if}

  <!-- ═══ BODY: map (fills everything left) + docked details pane ═══ -->
  <main class="relative flex min-h-0 flex-1">
    <div bind:this={mapBox} class="relative min-h-0 min-w-0 flex-1 touch-none {selectMode ? 'cursor-crosshair' : ''}" onpointerdown={lassoDown}>
      <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
      <!-- role="img"+aria-label is the intended pattern: present the canvas as one labeled image and route AT users to the deck list (the real accessible surface) -->
      <canvas bind:this={canvas} class="absolute inset-0 h-full w-full" role="img" aria-label="Document similarity map (visual). Use the deck list for a screen-reader-accessible view of the same cards."></canvas>

      <!-- the live lasso: a plain SVG overlay, inked from the theme's own base-content. Kept OUT of the
           deck layer stack on purpose — it is gesture feedback, not data, and it must not force a GPU
           re-render of the point cloud on every pointermove. pointer-events:none so deck still sees hovers. -->
      {#if lasso && lasso.length > 1}
        <svg class="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true">
          <polygon points={lasso.map((q) => q[0] + "," + q[1]).join(" ")}
            class="fill-base-content/5 stroke-base-content/70" stroke-width="1.5" stroke-dasharray="4 3" />
        </svg>
      {/if}
      {#if selectMode && !lasso}
        <div class="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
          <div class="rounded-field bg-base-100/85 px-2 py-1 font-mono text-[10px] shadow backdrop-blur">drag to circle cards · Escape to leave</div>
        </div>
      {/if}

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
      {#if hovered && data && selected === null && !lasso}
        <div class="rounded-box pointer-events-none absolute z-10 max-w-xs border border-base-300 bg-base-100/95 p-2.5 text-xs shadow-xl backdrop-blur"
          style="left:{Math.min(hovered.x + 14, (mapBox?.clientWidth ?? 800) - 280)}px; top:{Math.min(hovered.y + 14, (mapBox?.clientHeight ?? 600) - 120)}px">
          {#if hovered.kind === "point"}
            <div class="mb-1 flex items-center gap-1.5 font-mono text-[10px] opacity-60"><span class="h-2 w-2 flex-none rounded-xs" style="background:{rgb(colOf(assignment[hovered.i]))}"></span><span class="truncate">{regionOf(hovered.i)}</span></div>
            <!-- title only (eid-kzv2 item 4: "card hovers are noisy") — the card text belongs to the detail pane, not the hover -->
            <div class="font-bold leading-snug">{data.titles[hovered.i]}</div>
          {:else}
            <div class="mb-1 font-bold">{hovered.g.title}</div>
            <div class="font-mono text-[10px] opacity-60">frontier paper · cited {hovered.g.n}× in this corpus{hovered.g.arxiv ? " · arXiv:" + hovered.g.arxiv : ""}</div>
            <div class="mt-1 font-mono text-[10px] text-primary">click → open on arXiv ↗</div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- ═══ DETAILS PANE — an OVERLAY on the map's right edge (a bottom sheet on phones). It must never
         be a flex sibling of the map: that resized the canvas on every open/close — a layout shift on
         every dot click. The map is the primary surface; chrome floats over it, it never squeezes it. ═══ -->
    {#if sidebarOpen && data}
      <div use:focusOnOpen tabindex="-1" role="dialog" aria-label={selected !== null ? "card detail" : selection !== null ? "selection detail" : "region detail"}
        class="thin-sb fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-auto border-t border-base-300 bg-base-100 p-4 text-sm shadow-2xl sm:absolute sm:inset-y-0 sm:right-0 sm:left-auto sm:z-30 sm:max-h-none sm:w-88 sm:border-t-0 sm:border-l sm:shadow-xl">
        <button class="btn btn-ghost btn-sm btn-square sticky top-0 float-right ml-2" onclick={() => (selected !== null ? focusCard(null) : selection !== null ? m.clearSelection() : togglePin(pinned!))} aria-label="close">✕</button>
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
            <!-- a placement IS a position on a bipolar axis, so it renders as one: a mark on a track
                 between the two poles. A weak axis mutes the whole row — the quantity shows, no label. -->
            <div data-placement class="border-b border-base-200 py-1.5 text-xs {p.a.weak ? 'opacity-40' : ''}">
              <div class="flex justify-between gap-3 text-[10px] opacity-60"><span class="truncate">{p.a.low}</span><span class="truncate text-right">{p.a.high}</span></div>
              <div class="relative mt-1 h-[3px]">
                <div class="absolute inset-0 rounded-full bg-current opacity-10"></div>
                <span class="absolute top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" style="left:{p.s}%"></span>
              </div>
            </div>
          {/each}

          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">nearest {data.nbr[selected]?.length ?? 0}</div>
          {#each data.nbr[selected] ?? [] as j}
            <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-base-200" onclick={() => focusCard(j)}>→ {data.titles[j]}</button>
          {/each}
        {:else if selection}
          <!-- ═══ A HELD SELECTION — SELECT must EXPLAIN, not just grab. The count, then what actually
               distinguishes this set from the rest of the corpus (the same distinctiveTerms /
               distinctiveAxes the pipeline uses to name a region), then the verbs. ═══ -->
          <div class="mb-1 flex items-center gap-2 pr-8 font-bold"><span aria-hidden="true">◌</span><span data-sel-count>{selection.length} card{selection.length === 1 ? "" : "s"}</span></div>
          <div class="mb-3 font-mono text-[10px] opacity-60">selection · {Math.round((100 * selection.length) / (data.ids.length || 1))}% of the corpus</div>

          <div class="mb-2 flex flex-wrap gap-1">
            <button data-testid="sel-filter" class="btn btn-primary btn-xs normal-case" onclick={() => m.filterToSelection()}>filter to these</button>
            <button data-testid="sel-fit" class="btn btn-xs normal-case" onclick={() => fitTo(selection!)}>fit</button>
            <button data-testid="sel-descend" class="btn btn-xs normal-case" disabled={!!descendWhyNot || !!descending}
              title={descendWhyNot || "re-map these cards as their own space (local axes, in this tab)"} onclick={descendSelection}>descend</button>
            <button data-testid="sel-derive" class="btn btn-xs normal-case" disabled={!!deriveWhyNot}
              onclick={deriveAxis}>derive axis</button>
            <button data-testid="sel-clear" class="btn btn-ghost btn-xs normal-case" onclick={() => { m.clearSelection(); mintedKey = null; }}>clear</button>
          </div>

          <!-- descend's honest per-stage progress — the same narration ingest shows, in the pane that owns the verb -->
          {#if descending}
            <div data-testid="sel-descending" class="mb-2 space-y-1">
              <div class="flex items-center gap-2 font-mono text-[11px]">
                <span class="loading loading-spinner loading-xs text-primary"></span>
                <span class="min-w-0 flex-1 leading-snug">{descending.label}</span>
              </div>
              {#if descending.total}
                <progress class="progress progress-primary h-1 w-full" value={Math.round((100 * (descending.done ?? 0)) / descending.total)} max="100"></progress>
              {/if}
            </div>
          {/if}
          {#if descendErr}<div data-testid="sel-descend-err" class="mb-2 text-[11px] leading-snug text-error">{descendErr}</div>{/if}

          <!-- ═══ DERIVE: name the axis before (or after) you mint it. The result appears HERE with one-tap
               placements — minting alone moves nothing on the map. ═══ -->
          {#if deriveWhyNot && deriveWhyNot !== "nothing held"}
            <div data-derive-why class="rounded-field mb-2 bg-base-200 px-2 py-1 text-[11px] leading-snug opacity-70">{deriveWhyNot}</div>
          {:else}
            <label class="input input-xs mb-2 w-full gap-1">
              <span class="opacity-50">≈</span>
              <input data-testid="derive-label" bind:value={deriveLabel} placeholder={deriveDefault} aria-label="name the derived axis" class="min-w-0 grow" onkeydown={(e) => e.key === "Enter" && deriveAxis()} />
            </label>
          {/if}
          {#if deriveErr}<div class="mb-2 text-[11px] leading-snug text-error">{deriveErr}</div>{/if}
          {#if mintedDim}
            <div data-testid="derive-minted" class="rounded-field mb-2 bg-base-200 px-2 py-1.5 text-[11px]">
              <div class="mb-1 flex items-center gap-1">
                <input data-testid="derive-rename" value={m.derived.find((d) => d.key === mintedDim.key)?.label ?? ""} oninput={(e) => m.renameDerived(mintedDim.key, e.currentTarget.value)}
                  aria-label="rename this axis" class="input input-xs min-w-0 flex-1 font-mono" />
                <button onclick={() => { m.removeDimension(mintedDim.key); mintedKey = null; }} title="remove this axis" aria-label="remove this axis" class="btn btn-ghost btn-xs">✕</button>
              </div>
              <div class="flex items-center gap-1">
                <span class="opacity-60">place on</span>
                <button data-testid="derive-place-color" class="btn btn-xs normal-case" onclick={() => (m.channels.color = mintedDim.key)}>colour</button>
                <button data-testid="derive-place-size" class="btn btn-xs normal-case" onclick={() => (m.channels.size = mintedDim.key)}>size</button>
                <button data-testid="derive-place-x" class="btn btn-xs normal-case" onclick={() => (m.channels.x = mintedDim.key)}>x</button>
              </div>
            </div>
          {/if}

          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">what these share</div>
          {#if m.selectionTerms.length}
            <div data-sel-terms class="mb-2 flex flex-wrap gap-1">
              {#each m.selectionTerms as t}<span class="badge badge-sm badge-ghost font-mono">{t}</span>{/each}
            </div>
          {:else}
            <div class="mb-2 text-[11px] opacity-60">no term stands out against the corpus</div>
          {/if}
          {#each m.selectionAxes as a}
            {@const ax = data.axes.find((x) => x.name === a.name)}
            <!-- how far this set's mean sits from the corpus centre, as a diverging bar — direction and
                 magnitude in one mark -->
            <div data-sel-axis class="border-b border-base-200 py-1.5 text-xs {ax?.weak ? 'opacity-40' : ''}">
              <div class="flex justify-between gap-3 text-[10px] opacity-60"><span class="truncate">{ax?.low ?? ""}</span><span class="truncate text-right">{ax?.high ?? a.pole}</span></div>
              <div class="relative mt-1 h-[3px]">
                <div class="absolute inset-0 rounded-full bg-current opacity-10"></div>
                <div class="absolute top-0 h-full rounded-full bg-current opacity-60" style="left:{Math.min(a.mean, 50)}%; width:{Math.max(Math.abs(a.mean - 50), 1)}%"></div>
                <div class="absolute top-[-2px] h-[7px] w-px bg-current opacity-40" style="left:50%"></div>
              </div>
            </div>
          {/each}

          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">members</div>
          {#each selection.slice(0, 10) as i}
            <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-base-200" onclick={() => focusCard(i)}>{data.titles[i]}</button>
          {/each}
          {#if selection.length > 10}<div class="px-2 py-1 font-mono text-[10px] opacity-60">+{selection.length - 10} more</div>{/if}
        {:else if pinnedRegion}
          <div class="mb-1 flex items-center gap-2 pr-8 font-bold"><span class="h-3 w-3 flex-none rounded-xs" style="background:{rgb(colOf(pinnedRegion.c))}"></span><span class="truncate">{pinnedRegion.label}</span></div>
          <div class="mb-2 font-mono text-[10px] opacity-60">region · {pinnedRegion.n} cards · grain {m.grain + 1}/{nLevels}</div>
          {#if pinnedBlurb}<div class="mb-2 text-xs leading-relaxed opacity-80">{pinnedBlurb}</div>{/if}
          <div class="mb-2 flex flex-wrap gap-1">
            <button data-testid="region-fit" class="btn btn-xs normal-case" onclick={() => fitTo(m.membersOf(pinnedRegion.c))}>fit</button>
            <!-- second binding for region.drill (M-A1): the pane already knows the region — same act as double-clicking one of its points -->
            {#if m.grain < nLevels - 1}
              <button data-testid="region-drill" class="btn btn-xs normal-case" onclick={() => handle?.drillIndex(m.membersOf(pinnedRegion.c)[0] ?? -1)}>drill in</button>
            {/if}
          </div>
          <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide opacity-60">members</div>
          {#each m.membersOf(pinnedRegion.c).slice(0, 200) as i}
            <button class="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-base-200" onclick={() => focusCard(i)}>{data.titles[i]}</button>
          {/each}
        {/if}
      </div>
    {/if}
  </main>

  <!-- ═══ EMPTY STATE — the app's front door: open a .eido, or point it at a folder (eid-bacg) ═══ -->
  {#if noMap && !data && !ingest}
    <div class="fixed inset-0 z-50 grid place-items-center bg-base-100 px-6">
      <div class="w-full max-w-md" data-testid="open-panel">
        <div class="text-xl font-bold">eidoscope 🔭</div>
        <div class="mt-1 text-sm opacity-70">turn any folder of documents into an honest, holdable map — entirely in this tab.</div>
        <div class="mt-5 flex flex-col gap-2">
          <button class="btn btn-primary justify-start gap-2 normal-case" data-testid="open-folder-btn" onclick={() => folderInput?.click()} aria-label="open a folder of markdown or text files">
            <span>open a folder of .md / .txt</span>
          </button>
          <button class="btn justify-start gap-2 normal-case" data-testid="open-hf" onclick={() => (hfOpen = true)} aria-label="load a HuggingFace dataset">
            <span>map a HuggingFace dataset</span>
          </button>
          <label class="btn justify-start gap-2 normal-case">
            <span>open a .eido map</span>
            <input type="file" accept=".eido" class="hidden" data-testid="open-eido" onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) { noMap = false; openFile(f); } }} aria-label="open a .eido map file" />
          </label>
        </div>
        <div class="mt-3 font-mono text-[11px] opacity-50">…or drag a folder or a .eido anywhere onto this page</div>
        {#if noMapHint}<div class="mt-4 font-mono text-[10px] leading-snug opacity-40">no bundled map: {noMapHint}</div>{/if}
      </div>
    </div>
  {/if}

  <!-- ONE folder input for every doorway (eid-9rdy): the landing button and the open-menu item both
       click it, so folder ingest is reachable from ANY app state, not only the never-shown-in-prod
       empty state. Lives outside every conditional block on purpose. -->
  <input bind:this={folderInput} type="file" webkitdirectory multiple class="hidden" data-testid="open-folder" onchange={pickFolder} aria-label="open a folder of markdown or text files" />

  {#if hfOpen && !ingest}
    <HuggingFace onReady={connectorReady} onCancel={() => (hfOpen = false)} />
  {/if}

  {#if ingest}
    <Ingest files={ingest.files} name={ingest.name} source={ingest.source} onDone={ingestDone} onCancel={() => (ingest = null)} />
  {/if}

  {#if status}
    <div class="fixed inset-0 z-50 grid place-items-center bg-base-100 px-6">
      <div class="flex max-w-sm flex-col items-center gap-3 text-center font-mono text-sm">
        {#if !loadFailed}<span class="loading loading-spinner loading-md text-primary" aria-hidden="true"></span>{/if}
        <div class={loadFailed ? "" : "opacity-70"} role="status">{status}</div>
        {#if loadFailed}<button class="btn btn-sm" onclick={() => location.reload()}>reload</button>{/if}

        <!-- ═══ OPEN AFFORDANCES (eid-cawh) — a self-contained block on the empty state: the picker
             (or file-input fallback), the recent files IndexedDB remembers, and the drop hint.
             Deliberately separate from the status markup above to keep merges clean. ═══ -->
        {#if loadFailed}
          <div data-empty-open class="mt-2 flex w-full flex-col items-center gap-2 border-t border-base-300 pt-4">
            <button data-testid="empty:open" class="btn btn-sm btn-primary normal-case" onclick={openDoc}>open a .eido…</button>
            {#if recents.length}
              <div class="mt-1 font-mono text-[10px] uppercase tracking-widest opacity-50">recent</div>
              {#each recents as r, i}
                <button data-testid="empty:recent-{i}" class="btn btn-ghost btn-xs w-full justify-between gap-2 normal-case" onclick={() => openRecentDoc(r)}>
                  <span class="min-w-0 truncate">{r.name}</span><span class="flex-none font-mono text-[10px] opacity-50">{provDate(r.opened)}</span>
                </button>
              {/each}
            {/if}
            <div class="text-[10px] leading-snug opacity-50">…or drop a .eido anywhere on this window</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- the non-FSA open fallback (Safari/Firefox): a plain file input the open verb clicks for the user -->
  <input bind:this={fileInput} type="file" accept=".eido" class="hidden" aria-hidden="true" tabindex="-1" onchange={onFileInput} />

  <!-- controls sheet: the toolbar's contents, stacked — mobile always; desktop when the bar has folded -->
  {#if sheetOpen && data}
    <div class="fixed inset-0 z-50">
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
  {#if m.deckOpen && data}
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-2">
      <div use:trapFocus tabindex="-1" role="dialog" aria-modal="true" aria-label="deck reader" class="rounded-box flex h-full max-h-full w-full max-w-4xl flex-col border border-base-300 bg-base-100 p-3 shadow-2xl">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <!-- the deck's own scope (M-C4): its find/unread narrowing stays deck-local (M-N2), so its
               readout lives HERE — rows shown / cards the map shows -->
          <span data-deck-scope class="font-mono text-[10px] opacity-60">{deckList.length} / {visibleCount} cards</span>
          <label class="flex items-center gap-1 text-xs"><span class="font-mono text-[10px] opacity-60">sort</span>
            <select bind:value={m.channels.sort} aria-label="sort the deck" class="select select-xs">
              {#each scalarDims as d}<option value={d.key}>{d.name}{dimTag(d)}</option>{/each}
            </select></label>
          {#if hasRead}<button class="btn btn-xs normal-case {m.deckUnread ? 'btn-active' : 'btn-ghost'}" aria-pressed={m.deckUnread} onclick={() => (m.deckUnread = !m.deckUnread)}>unread only</button>{/if}
          <input bind:value={m.deckQ} placeholder="find in list…" aria-label="find in the list — narrows these rows only, not the map" class="input input-xs min-w-0 flex-1" />
          <button class="btn btn-ghost btn-xs btn-square ml-auto" onclick={() => requestClose()} aria-label="close deck">✕</button>
        </div>
        <div class="thin-sb grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
          {#if deckList.length === 0}<div class="col-span-full py-16 text-center font-mono text-xs opacity-60">no cards match “{m.deckQ}”{m.deckUnread ? " (unread only)" : ""}</div>{/if}
          {#each deckList as i (i)}
            <button data-deck-card class="rounded-box border border-base-300 bg-base-200 p-2.5 text-left hover:border-primary/50 {data.read?.[i] === true ? 'opacity-60' : ''}" onclick={() => { focusCard(i); m.deckOpen = false; }}>
              <div class="flex items-start justify-between gap-2">
                <div class="truncate text-[13px] font-bold">{data.titles[i]}</div>
                {#if data.sources?.[i] || data.urls?.[i]}<a href={data.sources?.[i] || data.urls?.[i]} target="_blank" rel="noopener" class="link link-primary flex-none font-mono text-[10px] font-bold" onclick={(e) => e.stopPropagation()}>open →</a>{/if}
              </div>
              <div class="my-1 line-clamp-2 text-[11px] opacity-70">{data.cores[i].slice(0, 160)}</div>
              <div class="flex flex-wrap gap-1">
                <span class="badge badge-xs font-mono">◆ {regionOf(i)}</span>
                {#each topAxes(i) as t}<span class="badge badge-xs badge-ghost font-mono {t.w ? 'opacity-50' : ''}" title={t.n}>{axShort(t.n)} {t.s}</span>{/each}
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
          <li><b class="opacity-100">Proximity is similarity</b> — in the neighbour map, nearby cards are alike. In axis scatter, position means each card's score on the two axes you chose.</li>
          <li><b class="opacity-100">Slide the grain</b> to move regions from continents to towns; click a region in the colour menu to isolate it.</li>
          <li><b class="opacity-100">Tap any card</b> to read it, see its nearest neighbours, and open the source.</li>
          <li><b class="opacity-100">Open the deck</b> to read the corpus as a sortable, filterable list — or switch layout to axis scatter.</li>
        </ul>
        <button class="btn btn-primary mt-4" onclick={dismissIntro}>explore →</button>
      </div>
    </div>
  {/if}
</div>
