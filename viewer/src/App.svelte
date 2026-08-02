<script lang="ts">
  import { onMount } from "svelte";
  import { loadMap } from "./loader";
  import { createMap, type MapHandle } from "./deckmap";
  import type { MapContract } from "../../src/schema";

  let canvas: HTMLCanvasElement;
  let status = $state("loading your map…");
  let data = $state<MapContract | null>(null);
  let selected = $state<number | null>(null);
  let handle: MapHandle | null = null;

  onMount(() => {
    (async () => {
      try {
        const D = await loadMap("./map.eido");
        data = D;
        status = "";
        handle = createMap(canvas, D, { onClick: (i) => (selected = i) });
      } catch (e: any) {
        status = "couldn't load map: " + (e?.message ?? e);
      }
    })();
    return () => handle?.destroy();
  });
</script>

<div class="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 touch-none">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>

  {#if status}
    <div class="absolute inset-0 grid place-items-center font-mono text-sm text-neutral-400">{status}</div>
  {/if}

  {#if data}
    <div class="absolute left-3 top-3 rounded-xl border border-neutral-800 bg-neutral-900/80 px-3 py-2 font-mono text-xs text-neutral-300 backdrop-blur">
      eidoscope 🔭 · {data.ids.length} cards · {data.k} regions
    </div>
  {/if}

  {#if selected !== null && data}
    <div class="absolute bottom-3 left-3 right-3 rounded-xl border border-neutral-800 bg-neutral-900/90 p-4 text-sm backdrop-blur sm:right-auto sm:w-80">
      <button class="absolute right-3 top-3 font-mono text-neutral-500" onclick={() => (selected = null)}>✕</button>
      <div class="mb-1 pr-6 font-bold">{data.titles[selected]}</div>
      <div class="text-xs leading-relaxed text-neutral-400">{data.cores[selected].slice(0, 280)}…</div>
      {#if data.urls?.[selected]}
        <a class="mt-2 inline-block font-mono text-xs font-bold text-blue-400" href={data.urls[selected]} target="_blank" rel="noopener">open source →</a>
      {/if}
    </div>
  {/if}
</div>
