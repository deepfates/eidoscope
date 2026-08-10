<script lang="ts">
  // The INGEST panel (eid-bacg): one folder → one map, narrated honestly per stage. Owns the run's
  // lifecycle (start / stop-at-axes-for-key / resume / retry-failures / CANCEL) and the key field; the
  // engine itself runs in the engine Web Worker (viewer/src/engine.worker.ts → src/engine.ts), so the
  // page stays interactive for the whole run and cancel really terminates the work. Emits the finished
  // MapContract upward — App mounts it through the SAME in-memory path a dropped .eido takes.
  import { engine, CancelledError, getKey, setKey, type IngestFile, type IngestStatus } from "./ingest";
  import type { Store } from "../../src/store";

  let { files, name, onDone, onCancel }: {
    files: IngestFile[]; name: string;
    onDone: (store: Store) => void; onCancel: () => void;
  } = $props();

  let key = $state(getKey());
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
    setKey(key.trim());
    try {
      const r = await engine.ingest(runId, files, name, key.trim(), (s) => (status = s));
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
      <!-- the key: user-held, browser-only. Without it the run stops at the axes stage and says so. -->
      <label class="mt-4 block">
        <span class="font-mono text-[10px] uppercase tracking-widest opacity-60">OpenRouter API key</span>
        <input type="password" data-testid="ingest-key" bind:value={key} placeholder="sk-or-…"
          class="input input-sm mt-1 w-full font-mono" aria-label="OpenRouter API key"
          onkeydown={(e) => e.key === "Enter" && go()} />
      </label>
      <div class="mt-1 text-[10px] leading-snug opacity-50">stored only in this browser (localStorage) — never written into any file. The page calls OpenRouter directly; nothing passes through any server of ours.</div>
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
          {!started ? (key.trim() ? "map it" : "map it (no key — stops at axes)") : error ? "resume" : "continue with this key"}
        </button>
      {/if}
      <button class="btn btn-ghost btn-sm normal-case" data-testid="ingest-cancel" onclick={cancel}>cancel</button>
    </div>
  </div>
</div>
