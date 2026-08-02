<script lang="ts">
  import { onMount } from "svelte";
  import { loadMap } from "./loader";
  import { createMap, type MapHandle } from "./deckmap";
  import { facets, colorFor, sizeFor, col, axisColor, type Facet } from "./encode";
  import type { MapContract } from "../../src/schema";

  let canvas: HTMLCanvasElement;
  let status = $state("loading your map…");
  let data = $state<MapContract | null>(null);
  let selected = $state<number | null>(null);
  let color = $state("cluster");
  let size = $state("hub");
  let fac = $state<Facet[]>([]);
  let handle: MapHandle | null = null;

  const axl = (a: any) => (a.weak ? "~ " : "") + a.name;
  const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

  onMount(() => {
    (async () => {
      try {
        const D = await loadMap("./map.eido");
        fac = facets(D);
        data = D;
        status = "";
        handle = createMap(canvas, D, { getColor: colorFor(D, color, fac), getRadius: sizeFor(D, size), onClick: (i) => (selected = i) });
      } catch (e: any) {
        status = "couldn't load map: " + (e?.message ?? e);
      }
    })();
    return () => handle?.destroy();
  });

  // re-encode reactively when color / size change
  $effect(() => {
    if (handle && data) handle.update({ getColor: colorFor(data, color, fac), getRadius: sizeFor(data, size) });
  });

  const curFacet = $derived(fac.find((f) => "meta:" + f.key === color));
</script>

<div class="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 touch-none">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>

  {#if status}
    <div class="absolute inset-0 grid place-items-center font-mono text-sm text-neutral-400">{status}</div>
  {/if}

  {#if data}
    <!-- control panel -->
    <div class="absolute left-3 top-3 w-56 rounded-xl border border-neutral-800 bg-neutral-900/80 p-3 backdrop-blur">
      <div class="mb-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500">eidoscope 🔭</div>
      <div class="mb-2 text-xs text-neutral-400">{data.ids.length} cards · {data.k} regions</div>
      <label class="mb-1.5 flex items-center gap-2 text-xs">
        <span class="w-9 font-mono text-[10px] text-neutral-500">color</span>
        <select bind:value={color} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">
          <option value="cluster">region</option>
          {#each fac as f}<option value={"meta:" + f.key}>{f.label}</option>{/each}
          {#each data.axes as a}<option value={a.key}>axis: {axl(a)}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-2 text-xs">
        <span class="w-9 font-mono text-[10px] text-neutral-500">size</span>
        <select bind:value={size} class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs">
          <option value="uniform">uniform</option>
          <option value="hub">influence (hub)</option>
          {#each data.axes as a}<option value={a.key}>commit: {axl(a)}</option>{/each}
        </select>
      </label>
    </div>

    <!-- legend -->
    <div class="absolute bottom-3 right-3 max-h-[48vh] w-52 overflow-auto rounded-xl border border-neutral-800 bg-neutral-900/80 p-2.5 text-xs backdrop-blur">
      {#if color === "cluster"}
        <div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{data.k} regions</div>
        {#each data.clusters as c}
          <div class="flex items-center gap-2 py-0.5">
            <span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(c.c))}"></span>
            <span class="truncate">{c.label} <span class="text-neutral-500">{c.n}</span></span>
          </div>
        {/each}
      {:else if curFacet}
        <div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{curFacet.label} · {curFacet.ord.length}</div>
        {#each curFacet.ord.slice(0, 16) as v}
          <div class="flex items-center gap-2 py-0.5">
            <span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(col(curFacet.idx[v]))}"></span>
            <span class="truncate">{v} <span class="text-neutral-500">{curFacet.cnt[v]}</span></span>
          </div>
        {/each}
        {#if curFacet.ord.length > 16}<div class="text-neutral-500">+{curFacet.ord.length - 16} more</div>{/if}
      {:else}
        {@const a = data.axes.find((x) => x.key === color)}
        {#if a}
          <div class="mb-1.5 font-mono text-[10px] uppercase text-neutral-500">{a.name}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(0))}"></span>{a.low}</div>
          <div class="flex items-center gap-2 py-0.5"><span class="h-2.5 w-2.5 flex-none rounded-sm" style="background:{rgb(axisColor(1))}"></span>{a.high}</div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if selected !== null && data}
    <div class="absolute bottom-3 left-3 right-3 rounded-xl border border-neutral-800 bg-neutral-900/90 p-4 text-sm backdrop-blur sm:right-auto sm:w-80">
      <button class="absolute right-3 top-3 font-mono text-neutral-500" onclick={() => (selected = null)} aria-label="close">✕</button>
      <div class="mb-1 pr-6 font-bold">{data.titles[selected]}</div>
      <div class="text-xs leading-relaxed text-neutral-400">{data.cores[selected].slice(0, 280)}…</div>
      {#if data.urls?.[selected]}
        <a class="mt-2 inline-block font-mono text-xs font-bold text-blue-400" href={data.urls[selected]} target="_blank" rel="noopener">open source →</a>
      {/if}
    </div>
  {/if}
</div>
