<script lang="ts">
  // The INGEST panel (eid-bacg): one folder → one map, narrated honestly per stage. Owns the run's
  // lifecycle (start / stop-at-axes-for-key / resume / retry-failures) and the key field; the engine
  // itself is viewer/src/ingest.ts → src/engine.ts. Emits the finished MapContract upward — App mounts
  // it through the SAME in-memory path a dropped .eido takes.
  import { IngestRun, EnvelopeError, getKey, setKey, type IngestFile, type IngestStatus } from "./ingest";
  import type { MapContract } from "../../src/schema";

  let { files, name, onDone, onCancel }: {
    files: IngestFile[]; name: string;
    onDone: (D: MapContract) => void; onCancel: () => void;
  } = $props();

  let key = $state(getKey());
  let status = $state<IngestStatus | null>(null);
  let error = $state("");
  let envelope = $state("");
  let started = $state(false);
  // a finished-but-partial map (some cards failed): held here, NOT auto-mounted — the user chooses
  // retry (session caches make it cheap: only failures re-spend) or an explicit open-without-them.
  let partial = $state<MapContract | null>(null);

  const run = new IngestRun(files, name, (s) => (status = s));

  async function go() {
    started = true; error = ""; partial = null;
    setKey(key.trim());
    try {
      const D = await run.start(key.trim());
      if (D && run.cardsFailed > 0) partial = D;
      else if (D) onDone(D);
      // null = stopped at the axes stage for want of a key — status.phase === "need-key" says why
    } catch (e: any) {
      if (e instanceof EnvelopeError) envelope = e.message;
      else error = String(e?.message ?? e);
    }
  }
  const pctOf = (s: IngestStatus) => (s.total ? Math.round((100 * (s.done ?? 0)) / s.total) : (s.pct ?? null));
  const running = $derived(started && !error && !envelope && !partial && status?.phase !== "need-key" && status?.phase !== "done");
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
        {#if status.failed && !partial}
          <div class="text-[11px] text-warning">{status.failed} card{status.failed === 1 ? "" : "s"} failed after retries — you can retry them when the pass finishes (everything written is kept).</div>
        {/if}
      </div>
    {/if}

    {#if run.warnings.length}
      <div class="mt-2 space-y-0.5">
        {#each run.warnings as w}<div class="font-mono text-[10px] leading-snug opacity-60">{w}</div>{/each}
      </div>
    {/if}

    {#if envelope}
      <div data-testid="ingest-envelope" class="rounded-field mt-4 bg-base-200 p-3 text-[12px] leading-snug">{envelope}</div>
    {/if}
    {#if error}
      <div data-testid="ingest-error" class="mt-4 text-[12px] leading-snug text-error">{error}</div>
    {/if}

    {#if partial}
      <div data-testid="ingest-partial" class="rounded-field mt-4 bg-base-200 p-3 text-[12px] leading-snug">
        {run.cardsFailed} card{run.cardsFailed === 1 ? "" : "s"} failed after retries. The map is built from the {partial.ids.length} that succeeded — retry the failures (only they re-spend), or open without them.
      </div>
    {/if}

    <div class="mt-5 flex gap-2">
      {#if partial}
        <button class="btn btn-primary btn-sm normal-case" data-testid="ingest-retry" onclick={go} disabled={run.running}>retry {run.cardsFailed} failed</button>
        <button class="btn btn-sm normal-case" data-testid="ingest-open-partial" onclick={() => onDone(partial!)}>open without them</button>
      {/if}
      {#if !envelope && !partial && (!started || status?.phase === "need-key" || error)}
        <button class="btn btn-primary btn-sm normal-case" data-testid="ingest-start" onclick={go} disabled={run.running}>
          {!started ? (key.trim() ? "map it" : "map it (no key — stops at axes)") : error ? "resume" : "continue with this key"}
        </button>
      {/if}
      <button class="btn btn-ghost btn-sm normal-case" data-testid="ingest-cancel" onclick={onCancel}>cancel</button>
    </div>
  </div>
</div>
