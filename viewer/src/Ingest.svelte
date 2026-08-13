<script lang="ts">
  // The INGEST panel (eid-bacg): one folder → one map, narrated honestly per stage. Owns the run's
  // lifecycle (start / stop-at-axes-for-key / resume / retry-failures / CANCEL) and the key field; the
  // engine itself runs in the engine Web Worker (viewer/src/engine.worker.ts → src/engine.ts), so the
  // page stays interactive for the whole run and cancel really terminates the work. Emits the finished
  // MapContract upward — App mounts it through the SAME in-memory path a dropped .eido takes.
  import { engine, CancelledError, loadCompute, saveCompute, listModels, estimate, LOCAL_FREE, PRESETS, EMBEDDERS, isLocal, fmtUsd, fmtTokens,
    type Compute, type ModelInfo, type IngestFile, type IngestStatus } from "./ingest";
  import type { Store } from "../../src/store";

  let { files, name, source, onDone, onCancel }: {
    files: IngestFile[]; name: string; source?: string;
    onDone: (store: Store) => void; onCancel: () => void;
  } = $props();

  // THE COMPUTE (eid-rcm8): which model, which embedder, where it runs, and what this costs — one object,
  // remembered between runs, and the same object the worker receives. The reader chooses before spending.
  let compute = $state<Compute>(loadCompute());
  let models = $state<ModelInfo[] | null>(null);
  let modelsErr = $state("");
  let modelsLoading = $state(false);
  // Open on arrival when a credential is actually needed and absent — the panel should present the
  // decision, not hide it one click away. A returning reader (key stored, or a local endpoint) gets the
  // compact summary instead, because for them there is nothing to decide.
  let showCompute = $state(!(loadCompute().key.trim() || isLocal(loadCompute().apiURL)));
  let filter = $state("");

  const local = $derived(isLocal(compute.apiURL));
  const ready = $derived(!!compute.key.trim() || local);
  // the corpus's own size, measured from the files in hand — not a guess about what a document weighs
  const corpusChars = $derived(files.reduce((n, f) => n + f.text.length, 0));
  const chosen = $derived(models?.find((m) => m.id === compute.model) ?? null);
  // a local endpoint is known-free from its URL — no model list needed to say so honestly
  const est = $derived(estimate(corpusChars, files.length, chosen ?? (local ? LOCAL_FREE : null)));

  // Load the endpoint's own model list. Failure is reported plainly and never blocks: the model field
  // stays a free-text input, so an endpoint that will not list still runs if you know its model name.
  async function loadModels() {
    modelsLoading = true; modelsErr = ""; models = null;
    try { models = await listModels(compute.apiURL, compute.key.trim()); }
    catch (e: any) { modelsErr = String(e?.message ?? e); }
    finally { modelsLoading = false; }
  }
  const shown = $derived(!models ? [] : (filter.trim()
    ? models.filter((m) => (m.id + " " + m.name).toLowerCase().includes(filter.trim().toLowerCase()))
    : models).slice(0, 60));
  let status = $state<IngestStatus | null>(null);
  let error = $state("");
  let started = $state(false);
  let warnings = $state<string[]>([]);
  let cardsFailed = $state(0);
  let inFlight = $state(false);
  // a finished-but-partial map (some cards failed): held here, NOT auto-mounted — the user chooses
  // retry (the caches make it cheap: only failures re-spend) or an explicit open-without-them.
  let partial = $state<Store | null>(null);

  // one run identity for the panel's lifetime: start-again (resume / retry) reuses the SAME worker's
  // in-memory embeddings, axes and written cards instead of re-spending them; the run's worker dies
  // with the panel (done/open/cancel — engine.cancelIngest), never outliving its owner.
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function go() {
    if (inFlight) return;   // one start owns the stream — no concurrent restart can rebind it
    started = true; error = ""; partial = null; inFlight = true;
    compute = { ...compute, key: compute.key.trim() };
    saveCompute(compute);
    try {
      const r = await engine.ingest(runId, files, name, compute, (s) => (status = s), source);
      warnings = r.warnings; cardsFailed = r.cardsFailed;
      if (r.store && r.cardsFailed > 0) partial = r.store;
      else if (r.store) onDone(r.store);
      // null store = stopped at the axes stage for want of a key — status.phase === "need-key" says why
    } catch (e: any) {
      if (!(e instanceof CancelledError)) error = String(e?.message ?? e);
    } finally { inFlight = false; }
  }
  function open(store: Store) { engine.cancelIngest(runId); onDone(store); }
  // cancel really cancels: the client terminates THIS run's worker mid-stage (nothing in the wasm/PCA
  // stack polls a signal); every cache line already flushed to OPFS survives, so a re-run resumes.
  function cancel() {
    engine.cancelIngest(runId);
    onCancel();
  }
  const pctOf = (s: IngestStatus) => (s.total ? Math.round((100 * (s.done ?? 0)) / s.total) : (s.pct ?? null));
  const running = $derived(started && !error && !partial && status?.phase !== "need-key" && status?.phase !== "done");
</script>

<div class="fixed inset-0 z-[65] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
  <div role="dialog" aria-label="open a corpus" class="rounded-box w-full max-w-md border border-base-300 bg-base-100 p-6 shadow-2xl">
    <div class="text-lg font-bold">map this folder 🔭</div>
    <div class="mt-1 font-mono text-[11px] opacity-60" data-testid="ingest-corpus">{name} · {files.length} file{files.length === 1 ? "" : "s"}</div>

    {#if !started || status?.phase === "need-key"}
      <!-- THE COMPUTE (eid-rcm8). Which model writes the cards, which embedder makes the vectors, where
           each runs, and what this corpus costs on that choice — stated before a single call is made. -->
      <div class="mt-4" data-testid="compute">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">compute</span>
          <button class="btn btn-ghost btn-xs normal-case" data-testid="compute-toggle" onclick={() => (showCompute = !showCompute)}>
            {showCompute ? "hide" : "change"}
          </button>
        </div>

        <!-- the one-line summary: what will run, and what it will cost -->
        <div class="rounded-field mt-1 bg-base-200 px-3 py-2 text-[11px] leading-snug" data-testid="compute-summary">
          <div class="font-mono">{compute.model}</div>
          <div class="opacity-60">
            via {local ? compute.apiURL : new URL(compute.apiURL).host} · embeds with {compute.embedder.split("/").pop()}
            {compute.device === "wasm" ? " on wasm" : ""}
          </div>
          <div class="mt-1" data-testid="compute-estimate">
            {#if est.usd === null}
              <span class="opacity-60">{files.length} documents · ~{fmtTokens(est.promptTokens)} in / ~{fmtTokens(est.completionTokens)} out — price unknown until the model list loads</span>
            {:else if est.free}
              <span class="text-success">no spend — this endpoint bills nothing.</span>
              <span class="opacity-60">Costs time instead: {files.length} documents through a local model.</span>
            {:else}
              <span class="font-bold">≈{fmtUsd(est.usd)}</span>
              <span class="opacity-60">for {files.length} documents (~{fmtTokens(est.promptTokens)} in, ~{fmtTokens(est.completionTokens)} out). A floor — axes and region naming add a little.</span>
            {/if}
          </div>
        </div>

        {#if showCompute}
          <div class="rounded-field mt-2 space-y-3 border border-base-300 p-3">
            <!-- where the model runs -->
            <div>
              <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">endpoint</span>
              <div class="mt-1 flex flex-wrap gap-1">
                {#each PRESETS as p}
                  <button class="btn btn-xs normal-case {compute.apiURL === p.apiURL ? 'btn-primary' : 'btn-ghost'}"
                    data-testid="preset-{p.label.toLowerCase().replace(' ', '-')}"
                    onclick={() => { compute = { ...compute, apiURL: p.apiURL }; models = null; modelsErr = ""; }}>{p.label}</button>
                {/each}
              </div>
              <input class="input input-xs mt-1 w-full font-mono" data-testid="compute-apiurl" bind:value={compute.apiURL}
                aria-label="OpenAI-compatible base URL" placeholder="https://…/v1"
                onchange={() => { models = null; modelsErr = ""; }} />
              <div class="mt-1 text-[10px] leading-snug opacity-50">
                {PRESETS.find((p) => p.apiURL === compute.apiURL)?.note ?? "any OpenAI-compatible base URL."}
              </div>
            </div>

            <!-- the credential, only where one is needed -->
            {#if !local}
              <label class="block">
                <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">api key</span>
                <input type="password" data-testid="ingest-key" bind:value={compute.key} placeholder="sk-or-…"
                  class="input input-sm mt-1 w-full font-mono" aria-label="API key"
                  onkeydown={(e) => e.key === "Enter" && go()} />
                <span class="mt-1 block text-[10px] leading-snug opacity-50">stored only in this browser (localStorage) — never written into any file. The page calls the endpoint directly; nothing passes through any server of ours.</span>
              </label>
            {:else}
              <div class="text-[10px] leading-snug opacity-50">no key needed — this endpoint runs on your machine.</div>
            {/if}

            <!-- which model, from the endpoint's own list -->
            <div>
              <div class="flex items-center justify-between">
                <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">model</span>
                <button class="btn btn-ghost btn-xs normal-case" data-testid="compute-load-models" onclick={loadModels} disabled={modelsLoading}>
                  {modelsLoading ? "loading…" : models ? `${models.length} models` : "list models"}
                </button>
              </div>
              <input class="input input-xs mt-1 w-full font-mono" data-testid="compute-model" bind:value={compute.model} aria-label="model id" />
              {#if modelsErr}
                <div class="mt-1 text-[10px] leading-snug text-warning" data-testid="compute-models-error">
                  couldn't list models — {modelsErr}. The field above still works if you know the model's name.
                </div>
              {/if}
              {#if models}
                <input class="input input-xs mt-1 w-full" data-testid="compute-filter" bind:value={filter} placeholder="filter…" aria-label="filter models" />
                <div class="mt-1 max-h-40 overflow-y-auto">
                  {#each shown as m}
                    <button class="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-base-200 {m.id === compute.model ? 'bg-base-200' : ''}"
                      data-testid="model-option" onclick={() => (compute = { ...compute, model: m.id })}>
                      <span class="min-w-0 flex-1 truncate font-mono">{m.id}</span>
                      <span class="flex-none opacity-60">
                        {#if m.free}free{:else}{fmtUsd(estimate(corpusChars, files.length, m).usd ?? 0)}{/if}
                      </span>
                    </button>
                  {/each}
                  {#if !shown.length}<div class="px-1.5 py-1 text-[11px] opacity-60">nothing matches "{filter}"</div>{/if}
                </div>
                <div class="mt-1 text-[10px] leading-snug opacity-50">the price beside each model is what THIS corpus would cost on it — the endpoint's own live pricing, not a table we ship.</div>
              {/if}
            </div>

            <!-- the embedder, and where it runs -->
            <div>
              <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">embedder</span>
              <select class="select select-xs mt-1 w-full font-mono" data-testid="compute-embedder" bind:value={compute.embedder} aria-label="embedder">
                {#each EMBEDDERS as e}<option value={e.id}>{e.label}</option>{/each}
              </select>
              <div class="mt-1 text-[10px] leading-snug opacity-50">{EMBEDDERS.find((e) => e.id === compute.embedder)?.note ?? ""}</div>
              <div class="mt-1.5 flex gap-1">
                <button class="btn btn-xs normal-case {compute.device === 'auto' ? 'btn-primary' : 'btn-ghost'}"
                  data-testid="device-auto" onclick={() => (compute = { ...compute, device: "auto" })}>GPU when available</button>
                <button class="btn btn-xs normal-case {compute.device === 'wasm' ? 'btn-primary' : 'btn-ghost'}"
                  data-testid="device-wasm" onclick={() => (compute = { ...compute, device: "wasm" })}>CPU (wasm)</button>
              </div>
              <div class="mt-1 text-[10px] leading-snug opacity-50">embedding runs in this page either way — WebGPU is several times faster where the browser has an adapter; the map is identical.</div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if status && started}
      <div class="mt-4 space-y-1" data-testid="ingest-status" data-phase={status.phase}>
        <div class="flex items-center gap-2 text-sm">
          {#if running}<span class="loading loading-spinner loading-xs text-primary"></span>{/if}
          <span class="min-w-0 flex-1 leading-snug {status.phase === 'need-key' ? '' : 'font-mono text-xs'}">{status.label}</span>
        </div>
        {#if running && pctOf(status) != null}
          <progress class="progress progress-primary h-1 w-full" value={pctOf(status)} max="100"></progress>
        {/if}
        <!-- the ESTIMATE line (replaces the old doc-count refusal): measured from THIS run's rates,
             informational, never blocking — the whole run happens in a worker, cancel any time -->
        {#if status.note && running}
          <div data-testid="ingest-estimate" class="text-[10px] leading-snug opacity-60">{status.note}</div>
        {/if}
        {#if status.failed && !partial}
          <div class="text-[11px] text-warning">{status.failed} card{status.failed === 1 ? "" : "s"} failed after retries — you can retry them when the pass finishes (everything written is kept).</div>
        {/if}
      </div>
    {/if}

    {#if warnings.length}
      <div class="mt-2 space-y-0.5">
        {#each warnings as w}<div class="font-mono text-[10px] leading-snug opacity-60">{w}</div>{/each}
      </div>
    {/if}

    {#if error}
      <div data-testid="ingest-error" class="mt-4 text-[12px] leading-snug text-error">{error}</div>
    {/if}

    {#if partial}
      <div data-testid="ingest-partial" class="rounded-field mt-4 bg-base-200 p-3 text-[12px] leading-snug">
        {cardsFailed} card{cardsFailed === 1 ? "" : "s"} failed after retries. The map is built from the {partial.map().ids.length} that succeeded — retry the failures (only they re-spend), or open without them.
      </div>
    {/if}

    <div class="mt-5 flex gap-2">
      {#if partial}
        <button class="btn btn-primary btn-sm normal-case" data-testid="ingest-retry" onclick={go} disabled={inFlight}>retry {cardsFailed} failed</button>
        <button class="btn btn-sm normal-case" data-testid="ingest-open-partial" onclick={() => open(partial!)}>open without them</button>
      {/if}
      {#if !partial && (!started || status?.phase === "need-key" || error)}
        <button class="btn btn-primary btn-sm normal-case" data-testid="ingest-start" onclick={go} disabled={inFlight}>
          {!started ? (ready ? "map it" : "map it (no key — stops at axes)") : error ? "resume" : "continue"}
        </button>
      {/if}
      <button class="btn btn-ghost btn-sm normal-case" data-testid="ingest-cancel" onclick={cancel}>cancel</button>
    </div>
  </div>
</div>
