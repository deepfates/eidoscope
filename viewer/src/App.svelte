<script lang="ts">
  import { onMount } from "svelte";
  import { loadMap } from "./loader";
  import { createMap, type MapHandle, type Layout } from "./deckmap";
  import { facets, colorFor, sizeFor, col, axisColor, type Facet } from "./encode";
  import type { MapContract } from "../../src/schema";

  let canvas: HTMLCanvasElement;
  let status = $state("loading your map…");
  let data = $state<MapContract | null>(null);
  let selected = $state<number | null>(null);
  let hovered = $state<{ i: number; x: number; y: number } | null>(null);
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
  let deckOpen = $state(false);
  let deckSort = $state("hub");
  let deckQ = $state("");
  let deckUnread = $state(false);
  const hasRead = $derived(!!data?.read?.some((r) => r === true || r === false));
  const axShort = (name: string) => name.split(/ vs\.? | and /i)[0].slice(0, 15);
  const deckList = $derived.by(() => {
    if (!data) return [] as number[];
    let list = data.ids.map((_, i) => i);
    const q = deckQ.trim().toLowerCase();
    if (q) list = list.filter((i) => data!.titles[i].toLowerCase().includes(q) || data!.cores[i].toLowerCase().includes(q));
    if (deckUnread && hasRead) list = list.filter((i) => data!.read![i] !== true);
    list.sort((a, b) => (deckSort === "hub" ? data!.hub[b] - data!.hub[a] : (data!.scores[deckSort]?.[b] ?? 0) - (data!.scores[deckSort]?.[a] ?? 0)));
    return list.slice(0, 300);
  });
  const labelsOn = $derived(showLabels && color === "cluster" && layout !== "orbit");
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
    else { pinned = c; handle?.setHighlight(c); handle?.fitToIndices(membersOf(c)); }
  }

  const axl = (a: any) => (a.weak ? "~ " : "") + a.name;
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const trunc = (s: string, m = 44) => (s && s.length > m ? s.slice(0, m - 1) + "…" : s);
  const regionOf = (i: number) => curClusters[assignment[i]]?.label ?? "";
  const dateOf = (i: number) => { const d = data?.dates?.[i]; return d ? new Date(d).toISOString().slice(0, 10) : ""; };
  const placements = (i: number) =>
    data ? data.axes.map((a) => ({ a, s: Math.round(data!.scores[a.key]?.[i] ?? 50), note: data!.notes[i]?.[a.key] || "" }))
      .filter((x) => x.note).sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 6) : [];
  const topAxes = (i: number) =>
    data ? data.axes.map((a) => ({ n: a.name, s: Math.round(data!.scores[a.key]?.[i] ?? 50) }))
      .sort((x, y) => Math.abs(y.s - 50) - Math.abs(x.s - 50)).slice(0, 3) : [];

  function focusCard(i: number | null) { selected = i; handle?.setFocus(i); }
  function reset() { focusCard(null); pinned = null; handle?.setHighlight(null); grain = data?.di ?? 0; handle?.resetView(); }

  onMount(() => {
    (async () => {
      try {
        const D = await loadMap("./map.eido");
        fac = facets(D);
        xKey = D.axes[0]?.key ?? "";
        yKey = D.axes[1]?.key ?? D.axes[0]?.key ?? "";
        grain = D.di ?? 0;
        data = D;
        status = "";
        handle = createMap(canvas, D, {
          getColor: colorFor(D, color, fac, D.levels?.[grain] ?? D.cluster), getRadius: sizeFor(D, size), layout, xKey, yKey, showLabels: labelsOn, grain,
          onClick: (i) => focusCard(i < 0 ? null : i),
          onHover: (i, x, y) => (hovered = i == null ? null : { i, x, y }),
          onGrainChange: (g) => { grain = g; pinned = null; },
        });
      } catch (e: any) {
        status = "couldn't load map: " + (e?.message ?? e);
      }
    })();
    return () => handle?.destroy();
  });

  $effect(() => {
    const l = layout, c = color, s = size, xk = xKey, yk = yKey, sl = labelsOn, g = grain, a = assignment, h = handle, d = data, f = fac;
    if (h && d) h.update({ getColor: colorFor(d, c, f, a), getRadius: sizeFor(d, s), layout: l, xKey: xk, yKey: yk, showLabels: sl, grain: g });
  });

  const curFacet = $derived(fac.find((f) => "meta:" + f.key === color));
  const xAxis = $derived(data?.axes.find((a) => a.key === xKey));
  const yAxis = $derived(data?.axes.find((a) => a.key === yKey));
  const hint = $derived(layout === "axes" ? "positioned by where each card projects on the two axes" : layout === "orbit" ? "drag to rotate · pinch to zoom" : "proximity = similarity · tap a card");
</script>

<div class="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 touch-none">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>

  {#if status}<div class="absolute inset-0 grid place-items-center font-mono text-sm text-neutral-400">{status}</div>{/if}

  {#if data}
    {#if layout === "axes" && xAxis && yAxis}
      <div class="pointer-events-none absolute inset-0 font-mono text-xs text-neutral-300/90">
        <div class="absolute left-3 top-1/2 -translate-y-1/2">← {trunc(xAxis.low)}</div>
        <div class="absolute right-3 top-1/2 -translate-y-1/2 text-right">{trunc(xAxis.high)} →</div>
        <div class="absolute left-1/2 top-3 -translate-x-1/2">↑ {trunc(yAxis.high)}</div>
        <div class="absolute bottom-9 left-1/2 -translate-x-1/2">↓ {trunc(yAxis.low)}</div>
      </div>
    {/if}

    <div class="absolute left-3 top-3 w-56 rounded-xl border border-neutral-800 bg-neutral-900/80 p-3 backdrop-blur">
      <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500">eidoscope 🔭</div>
      <div class="mb-2 text-xs text-neutral-400">{data.ids.length} cards · {data.k} regions</div>
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-neutral-500">layout</span>
        <select bind:value={layout} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">
          <option value="mde">neighbor map</option><option value="axes">axis scatter</option><option value="orbit">3D orbit</option>
        </select></label>
      {#if layout === "axes"}
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-neutral-500">x-axis</span>
          <select bind:value={xKey} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}</select></label>
        <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-neutral-500">y-axis</span>
          <select bind:value={yKey} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}</select></label>
      {/if}
      <label class="mb-1.5 flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-neutral-500">color</span>
        <select bind:value={color} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">
          <option value="cluster">region</option>{#each fac as f}<option value={"meta:" + f.key}>{f.label}</option>{/each}{#each data.axes as a}<option value={a.key}>axis: {axl(a)}</option>{/each}
        </select></label>
      <label class="flex items-center gap-2 text-xs"><span class="w-9 flex-none font-mono text-[10px] text-neutral-500">size</span>
        <select bind:value={size} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">
          <option value="uniform">uniform</option><option value="hub">influence (hub)</option>{#each data.axes as a}<option value={a.key}>commit: {axl(a)}</option>{/each}
        </select></label>
      {#if nLevels > 1}
        <label class="mt-2 flex items-center gap-2 text-xs">
          <span class="w-9 flex-none font-mono text-[10px] text-neutral-500">grain</span>
          <input type="range" min="0" max={nLevels - 1} bind:value={grain} oninput={() => (pinned = null)} class="min-w-0 flex-1 accent-neutral-400" />
          <span class="w-6 flex-none text-right font-mono text-[10px] text-neutral-500">{curCount}</span>
        </label>
      {/if}
      <div class="mt-2 flex gap-2">
        <button class="flex-1 rounded-md border border-neutral-700 px-2 py-1 font-mono text-[11px] text-neutral-300 hover:bg-neutral-800" onclick={() => (deckOpen = true)}>deck</button>
        <button class="flex-1 rounded-md border border-neutral-700 px-2 py-1 font-mono text-[11px] {showLabels ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'}" onclick={() => (showLabels = !showLabels)}>labels</button>
        <button class="flex-1 rounded-md border border-neutral-700 px-2 py-1 font-mono text-[11px] text-neutral-300 hover:bg-neutral-800" onclick={reset}>reset</button>
      </div>
    </div>

    <div class="absolute bottom-3 right-3 max-h-[48vh] w-52 overflow-auto rounded-xl border border-neutral-800 bg-neutral-900/80 p-2.5 text-xs backdrop-blur">
      {#if color === "cluster"}
        <div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{curCount} regions · click to isolate</div>
        {#each curClusters as c}<div class="flex cursor-pointer items-center gap-2 py-0.5 hover:text-white {pinned === c.c ? 'text-white' : ''}" role="button" tabindex="0" onmouseenter={() => { if (pinned === null) handle?.setHighlight(c.c); }} onmouseleave={() => { if (pinned === null) handle?.setHighlight(null); }} onclick={() => togglePin(c.c)}><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(c.c))}"></span><span class="truncate">{c.label} <span class="text-neutral-500">{c.n}</span></span></div>{/each}
      {:else if curFacet}
        <div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{curFacet.label} · {curFacet.ord.length}</div>
        {#each curFacet.ord.slice(0, 16) as v}<div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(curFacet.idx[v]))}"></span><span class="truncate">{v} <span class="text-neutral-500">{curFacet.cnt[v]}</span></span></div>{/each}
        {#if curFacet.ord.length > 16}<div class="text-neutral-500">+{curFacet.ord.length - 16} more</div>{/if}
      {:else}
        {@const a = data.axes.find((x) => x.key === color)}
        {#if a}<div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{a.name}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(0))}"></span>{a.low}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(1))}"></span>{a.high}</div>{/if}
      {/if}
    </div>

    <div class="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 font-mono text-[11px] text-neutral-500">{hint}</div>
  {/if}

  <!-- hover tooltip -->
  {#if hovered && data && selected === null}
    <div class="pointer-events-none absolute z-10 max-w-xs rounded-lg border border-neutral-800 bg-neutral-900/95 p-2.5 text-xs shadow-xl" style="left:{Math.min(hovered.x + 14, window.innerWidth - 280)}px; top:{Math.min(hovered.y + 14, window.innerHeight - 120)}px">
      <div class="mb-1 font-bold">{data.titles[hovered.i]}</div>
      <div class="mb-1 line-clamp-2 text-neutral-400">{data.cores[hovered.i].slice(0, 140)}</div>
      <div class="font-mono text-[10px] text-neutral-500">hub {data.hub[hovered.i]} · {topAxes(hovered.i).map((t) => t.n + " " + t.s).join(" · ")}</div>
    </div>
  {/if}

  <!-- detail panel -->
  {#if selected !== null && data}
    <div class="absolute bottom-3 left-3 right-3 max-h-[64vh] overflow-auto rounded-xl border border-neutral-800 bg-neutral-900/95 p-4 text-sm backdrop-blur sm:right-auto sm:w-80">
      <button class="absolute right-3 top-3 font-mono text-neutral-500 hover:text-neutral-200" onclick={() => focusCard(null)} aria-label="close">✕</button>
      <div class="mb-1 pr-6 font-bold">{data.titles[selected]}</div>
      <div class="mb-2 font-mono text-[10px] text-neutral-500">{[data.authors?.[selected], dateOf(selected), regionOf(selected)].filter(Boolean).join(" · ")}</div>
      {#if data.urls?.[selected]}<a class="mb-2 inline-block font-mono text-xs font-bold text-blue-400 hover:underline" href={data.urls[selected]} target="_blank" rel="noopener">open source →</a>{/if}
      <div class="mb-1 text-xs leading-relaxed text-neutral-300">{data.cores[selected].slice(0, 420)}{data.cores[selected].length > 420 ? "…" : ""}</div>

      <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">where it sits</div>
      {#each placements(selected) as p}
        <div class="flex items-center justify-between gap-2 border-b border-neutral-800 py-1 text-xs" title={(p.s >= 50 ? p.a.high : p.a.low) + " — " + p.note}>
          <span class="truncate text-neutral-400">{p.a.name}</span>
          <span class="flex-none font-mono text-[10px]">{p.s >= 50 ? "▲" : "▼"} <b>{p.s}</b></span>
        </div>
      {/each}

      <div class="mt-3 mb-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">nearest {data.nbr[selected]?.length ?? 0}</div>
      {#each data.nbr[selected] ?? [] as j}
        <button class="block w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-neutral-800" onclick={() => focusCard(j)}>→ {data.titles[j]}</button>
      {/each}
    </div>
  {/if}

  <!-- deck / list view — the accessible, sortable/filterable reader (real DOM, keyboard-navigable) -->
  {#if deckOpen && data}
    <div class="absolute inset-x-2 top-2 bottom-2 z-30 mx-auto flex max-w-4xl flex-col rounded-xl border border-neutral-800 bg-neutral-950/95 p-3 backdrop-blur">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <b class="text-sm">Deck</b>
        <span class="font-mono text-[10px] text-neutral-500">{deckList.length} cards</span>
        <label class="flex items-center gap-1 text-xs"><span class="font-mono text-[10px] text-neutral-500">sort</span>
          <select bind:value={deckSort} class="rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs">
            <option value="hub">influence</option>{#each data.axes as a}<option value={a.key}>{axl(a)}</option>{/each}
          </select></label>
        {#if hasRead}<button class="rounded-md border border-neutral-700 px-2 py-1 font-mono text-[11px] {deckUnread ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'}" onclick={() => (deckUnread = !deckUnread)}>unread only</button>{/if}
        <input bind:value={deckQ} placeholder="filter…" class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs" />
        <button class="font-mono text-neutral-500 hover:text-neutral-200" onclick={() => (deckOpen = false)} aria-label="close deck">✕</button>
      </div>
      <div class="grid grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
        {#each deckList as i (i)}
          <button class="rounded-lg border border-neutral-800 bg-neutral-900 p-2.5 text-left hover:border-neutral-600 {data.read?.[i] === true ? 'opacity-60' : ''}" onclick={() => { focusCard(i); deckOpen = false; }}>
            <div class="flex items-start justify-between gap-2">
              <div class="truncate text-[13px] font-bold">{data.titles[i]}</div>
              {#if data.urls?.[i]}<a href={data.urls[i]} target="_blank" rel="noopener" class="flex-none font-mono text-[10px] font-bold text-blue-400 hover:underline" onclick={(e) => e.stopPropagation()}>open →</a>{/if}
            </div>
            <div class="my-1 line-clamp-2 text-[11px] text-neutral-400">{data.cores[i].slice(0, 160)}</div>
            <div class="flex flex-wrap gap-1">
              <span class="rounded-full bg-neutral-800 px-2 py-0.5 font-mono text-[9px] text-neutral-200">◆ {regionOf(i)}</span>
              {#each topAxes(i) as t}<span class="rounded-full bg-neutral-800/70 px-2 py-0.5 font-mono text-[9px] text-neutral-400">{axShort(t.n)} {t.s}</span>{/each}
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
