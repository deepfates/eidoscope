<script lang="ts">
  // The HuggingFace connector's UI (eid-ilc5): paste an id or URL → look it up → pick the text
  // column → fetch every row with honest count-based progress → hand a CorpusPayload up. The
  // ingest itself (embed → axes → cards → map) is NOT here — App feeds the payload to the same
  // Ingest panel the folder connector uses. Envelope honesty happens BEFORE the download: the row
  // count is known up front, so a split past the in-page envelope is refused here with the same
  // CLI line IngestRun would give, instead of after fetching it all.
  import { previewDataset, fetchDataset, type HFPreview } from "./huggingface";
  import type { CorpusPayload } from "./types";
  import { INPAGE_ENVELOPE_DOCS } from "../ingest";

  let { onReady, onCancel }: { onReady: (p: CorpusPayload) => void; onCancel: () => void } = $props();

  let input = $state("");
  let preview = $state<HFPreview | null>(null);
  let column = $state("");
  let busy = $state<"lookup" | "rows" | null>(null);
  let error = $state("");
  let progress = $state<{ done: number; total: number } | null>(null);
  let abort: AbortController | null = null;

  const overEnvelope = $derived(!!preview && preview.numRowsTotal > INPAGE_ENVELOPE_DOCS);

  async function lookup() {
    if (busy) return;
    busy = "lookup"; error = ""; preview = null;
    try {
      preview = await previewDataset(input);
      column = preview.textColumns.includes("text") ? "text" : preview.textColumns[0];
    } catch (e: any) { error = String(e?.message ?? e); }
    finally { busy = null; }
  }

  async function ingest() {
    if (busy || !preview) return;
    busy = "rows"; error = ""; progress = { done: 0, total: preview.numRowsTotal };
    abort = new AbortController();
    try {
      const payload = await fetchDataset(preview, column, (done, total) => (progress = { done, total }), abort.signal);
      onReady(payload);
    } catch (e: any) { if (!abort.signal.aborted) error = String(e?.message ?? e); progress = null; }
    finally { busy = null; abort = null; }
  }

  function cancel() { abort?.abort(); onCancel(); }
</script>

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
  <div role="dialog" aria-label="load a HuggingFace dataset" class="rounded-box w-full max-w-md border border-base-300 bg-base-100 p-6 shadow-2xl">
    <div class="text-lg font-bold">map a HuggingFace dataset 🤗</div>
    <div class="mt-1 text-[11px] leading-snug opacity-60">public datasets, fetched straight from the datasets-server API — nothing passes through any server of ours.</div>

    <label class="mt-4 block">
      <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">dataset id or URL</span>
      <input type="text" data-testid="hf-id" bind:value={input} placeholder="user/dataset or huggingface.co/datasets/…"
        class="input input-sm mt-1 w-full font-mono" aria-label="HuggingFace dataset id or URL"
        disabled={busy === "rows"} onkeydown={(e) => e.key === "Enter" && lookup()} />
    </label>

    {#if preview}
      <div class="mt-3 font-mono text-[11px] opacity-70" data-testid="hf-preview">
        {preview.dataset} · {preview.config}/{preview.split} · {preview.numRowsTotal.toLocaleString()} rows
      </div>
      <label class="mt-2 block">
        <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">text column</span>
        <select class="select select-sm mt-1 w-full font-mono" data-testid="hf-column" bind:value={column} disabled={busy === "rows"} aria-label="which column holds the document text">
          {#each preview.textColumns as c}<option value={c}>{c}</option>{/each}
        </select>
      </label>
      {#if preview.sample.length && column}
        <div class="rounded-field mt-2 max-h-24 overflow-hidden bg-base-200 p-2 font-mono text-[10px] leading-snug opacity-60" data-testid="hf-sample">{String(preview.sample[0]?.[column] ?? "").slice(0, 400)}</div>
      {/if}
      {#if overEnvelope}
        <div class="rounded-field mt-3 bg-base-200 p-3 text-[12px] leading-snug" data-testid="hf-envelope">
          {preview.numRowsTotal.toLocaleString()} rows is past the in-page envelope (~{INPAGE_ENVELOPE_DOCS.toLocaleString()} documents).
          Build this one with the CLI twin — <span class="font-mono">eidoscope</span> — and open the .eido it emits here; same engine, same file.
        </div>
      {/if}
    {/if}

    {#if progress && busy === "rows"}
      <div class="mt-3 space-y-1" data-testid="hf-progress">
        <div class="flex items-center gap-2 font-mono text-xs">
          <span class="loading loading-spinner loading-xs text-primary"></span>
          <span>fetching rows {progress.done.toLocaleString()}/{progress.total.toLocaleString()}</span>
        </div>
        <progress class="progress progress-primary h-1 w-full" value={progress.total ? Math.round((100 * progress.done) / progress.total) : 0} max="100"></progress>
      </div>
    {/if}

    {#if error}<div data-testid="hf-error" class="mt-3 text-[12px] leading-snug text-error">{error}</div>{/if}

    <div class="mt-5 flex gap-2">
      {#if !preview}
        <button class="btn btn-primary btn-sm normal-case" data-testid="hf-lookup" onclick={lookup} disabled={!!busy || !input.trim()}>
          {#if busy === "lookup"}<span class="loading loading-spinner loading-xs"></span>{/if}look it up
        </button>
      {:else}
        {#if !overEnvelope}
          <button class="btn btn-primary btn-sm normal-case" data-testid="hf-ingest" onclick={ingest} disabled={!!busy || !column}>
            ingest {preview.numRowsTotal.toLocaleString()} rows
          </button>
        {/if}
        <button class="btn btn-sm normal-case" data-testid="hf-relookup" onclick={() => { preview = null; error = ""; }} disabled={busy === "rows"}>different dataset</button>
      {/if}
      <button class="btn btn-ghost btn-sm normal-case" data-testid="hf-cancel" onclick={cancel}>cancel</button>
    </div>
  </div>
</div>
