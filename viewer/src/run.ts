// THE RUN, worker-side (eid-yhj7 async engine) — the page FACE of the ONE engine (src/engine.ts),
// executed inside the engine Web Worker (viewer/src/engine.worker.ts) so the tab never freezes: the
// stages (embed via transformers.js, PCA/axes, carding fetches, layout, naming) all happen here, and
// the main thread only sees a stream of IngestStatus messages plus the finished MapContract. This
// module binds the host-free stages to the browser host — plain {path,name,text} files instead of fs,
// transformers.js as the embedder (viewer/src/embedder.ts), an OpenRouter client built from the
// user-held key (fetch works identically in workers; CORS allow-origin:* measured 2026-08-09), and
// OPFS caches (which make a partial run RESUMABLE: retry re-runs failures only — and OPFS's
// createSyncAccessHandle is worker-only, so the cache adapter is at home here).
import { ai } from "@ax-llm/ax";
import { docsFromFiles, splitOversized, parseVaultManifest, type Doc } from "../../src/corpus-core";
import { buildMap, descendMap, type EngineProgress, type DescendParent } from "../../src/engine";
import { poolEmbedWith } from "../../src/geometry";
import { discoverAxes, type Axis, type AxesProgress } from "../../src/axes";
import { Store } from "../../src/llm";
import { DEFAULT_MODEL, DEFAULT_API_URL, DEFAULT_EMBED_MODEL, DEFAULT_MAX_DOC_CHARS } from "../../src/defaults";
import type { MapContract } from "../../src/schema";
import { embedItems, type EmbedProgress } from "./embedder";
import { opfsStore, cacheFileName, persistSummary } from "./opfs";
// the kNN regime seam (agent/knn-regimes): exact WebGPU whenever this worker's context exposes an
// adapter (WebGPU is available in dedicated workers), calibrated hnswlib-wasm without one — the same
// environment-only chooser the node host runs, so derivedBy.neighbors is honest from either host
import { pageKnn } from "./knn";

// ax stamps x-request-id / x-retry-count onto every request. OpenRouter's CORS allow-list doesn't
// include them, so a browser's preflight rejects the whole call ("Failed to fetch") and ax retries
// into the void — measured 2026-08-10: a raw fetch to the same endpoint answers in 1.4s while every
// ax call dies. Fixed through ax's own extension point (AxAIServiceOptions.fetch — "useful for
// proxies or custom HTTP handling"): a scoped fetch that drops exactly those two headers. Upstream
// issue to file with ax: browser targets shouldn't send un-allowlisted tracking headers.
const corsSafeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.delete("x-request-id"); h.delete("x-retry-count");
    init = { ...init, headers: h };
  }
  return fetch(input, init);
}) as typeof fetch;

export const pageLLM = (key: string) =>
  ai({ name: "openai", apiKey: key, apiURL: DEFAULT_API_URL, config: { model: DEFAULT_MODEL, stream: false }, options: { fetch: corsSafeFetch } } as any);

// `meta` (eid-xmf0): connector-carried row metadata (an HF row's non-text columns, a file's mtime) —
// plain JSON values only (it crosses postMessage); docsFromFiles moves it onto the Doc, and
// assembleContract turns the union into the map's generic column store (MapContract.cols).
export type IngestFile = { path: string; name: string; text: string; meta?: Record<string, unknown> };

// ── honest per-stage progress, streamed over postMessage to whichever pane owns the verb ────────────
export type IngestStatus = {
  phase: "read" | "model" | "embed" | "axes" | "need-key" | "cards" | "embed-cards" | "layout" | "regions" | "done" | "error";
  label: string;
  done?: number; total?: number; failed?: number; pct?: number;
  // The ESTIMATE line (replaces the old refusal envelope): computed from THIS run's measured rates —
  // chunk rate once the model is warm, per-card/per-region call rate once a few complete. Honest
  // "measuring…" before the data exists, numbers as they firm up. Informational, never blocking.
  note?: string;
};

// A per-stage rate meter: ETA from the slope of (done, time) measured IN this run — never a constant.
// The first sample only anchors the clock; an estimate exists once ≥3 items and ≥1s of slope are real.
class Rate {
  private t0 = 0; private n0 = 0;
  eta(done: number, total: number): number | null {
    const now = Date.now();
    if (!this.t0) { this.t0 = now; this.n0 = done; return null; }
    const dn = done - this.n0, dt = now - this.t0;
    if (dn < 3 || dt < 1000) return null;
    return Math.max(0, (total - done) * (dt / dn));
  }
}
const fmtEta = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 100 ? `${s}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
};

// Map the deterministic axes-discovery progress (PCA + 8 shuffle replicates + one naming call) onto a
// status setter — shared by ingest and descend so neither shows a static label through the minutes.
const axesNarration = (set: (s: IngestStatus) => void, n: () => number, named: boolean) => {
  let namingT0 = 0; let tick: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (tick) { clearInterval(tick); tick = undefined; } };
  const on = (p: AxesProgress) => {
    if (p.step === "pca") set({ phase: "axes", label: `PCA over ${n()} ${named ? "docs" : "cards"} (truncated, exact)…` });
    else if (p.step === "noise") set({ phase: "axes", label: `noise floor: shuffle replicate ${p.rep}/${p.of} (parallel analysis)`, done: p.rep, total: p.of });
    else if (p.step === "naming") {
      namingT0 = Date.now();
      const line = () => set({ phase: "axes", label: `naming ${p.axes} axes — one contrastive call so they stay distinct… ${Math.round((Date.now() - namingT0) / 1000)}s` });
      line(); stop(); tick = setInterval(line, 1000);
    }
  };
  return { on, stop };
};

// ── DESCEND as a gesture (eid-kep3): the worker FACE of src/engine.ts descendMap ────────────────────
// The selection pane calls this (through the engine client) with the held ids; the child map comes back
// as a plain MapContract the app mounts through the SAME in-memory path a dropped .eido takes.
// The key is OPTIONAL — the cards already exist, so without one the child opens honest-but-unnamed:
// PC axis names + deterministic contrastive-term region labels (naming can be applied later with a key).
export async function descendInPage(P: DescendParent, selIds: string[], key: string, onStatus: (s: IngestStatus) => void): Promise<MapContract> {
  const llm = key ? pageLLM(key) : undefined;
  const ax = axesNarration(onStatus, () => selIds.length, false);
  const regionRate = new Rate();
  try {
    return await descendMap(P, selIds, {
      llm, knn: pageKnn, regionCache: await opfsStore(cacheFileName("regions")),
      onProgress: (p: EngineProgress) => {
        if (p.stage === "axes") onStatus({ phase: "axes", label: `discovering local axes over ${p.docs} cards…` });
        else if (p.stage === "axes-noise") ax.on({ step: "noise", rep: p.rep, of: p.of });
        else if (p.stage === "axes-naming") ax.on({ step: "naming", axes: p.axes });
        else if (p.stage === "axes-done") { ax.stop(); onStatus({ phase: "axes", label: `${p.axes} local axes (${p.realDims} above the noise floor)` }); }
        else if (p.stage === "layout") onStatus({ phase: "layout", label: `laying out ${p.cards} cards (UMAP + clustering)…` });
        else if (p.stage === "regions") {
          const eta = llm ? regionRate.eta(p.done, p.total) : null;
          onStatus({ phase: "regions", label: `${llm ? "naming" : "labeling"} regions ${p.done}/${p.total}`, done: p.done, total: p.total, note: eta != null ? `≈${fmtEta(eta)} left — measured from this run's naming rate` : undefined });
        }
      },
    });
  } finally { ax.stop(); }
}

// One ingest of one folder. `start(key)` runs as far as it honestly can — with no key it stops after
// the axes stage (the card is the bottleneck AND the point: without a key there are no cards, so no
// map; we say so instead of shipping a cardless fake). Calling start again (same run) RESUMES: the
// full-text embeddings, discovered geometry and every already-written card are kept in the caches,
// so only failures and the not-yet-done stages spend anything. There is NO doc-count refusal: any
// corpus runs, the panel narrates measured time estimates, and cancel is always live (the client
// terminates this worker — every flushed cache line survives in OPFS, so a re-run resumes).
export class IngestRun {
  status: IngestStatus = { phase: "read", label: "reading files…" };
  private docs: Doc[] | null = null;
  private embeddings: number[][] | null = null;
  private axesNamedWithLLM = false;
  private axes: { axes: Axis[]; realDims: number; projections: number[][] } | null = null;
  // The caches, OPFS-persisted when the browser can (viewer/src/opfs.ts), session-memory when it
  // can't. Keys are content-addressed (doc text + axis geometry for cards; distinctive terms for
  // regions; chunk hash for embeddings), so the files are shared across corpora and sessions exactly
  // like the node cache dir — a reopened tab reloads instead of re-spending. Opened lazily (OPFS
  // handles are async) on first start().
  private cardCache: Store | null = null;
  private regionCache: Store | null = null;
  private embCache: Store | null = null;
  private async openCaches(): Promise<void> {
    if (this.cardCache) return;
    [this.cardCache, this.regionCache, this.embCache] = await Promise.all([
      opfsStore(cacheFileName("cards")),
      opfsStore(cacheFileName("regions")),
      opfsStore(cacheFileName("emb", DEFAULT_EMBED_MODEL)),
    ]);
  }
  cardsFailed = 0;                     // failures in the LAST carding pass (a retry re-runs only these)
  running = false;

  constructor(
    public files: IngestFile[],
    public name: string,
    public onStatus: (s: IngestStatus) => void,   // public: a resumed run re-binds it to the new request's stream
    // provenance.source — which connector this corpus truthfully came through (connectors/types.ts);
    // defaults to the folder connector's line.
    private source?: string,
  ) {}

  private set(s: IngestStatus) { this.status = s; this.onStatus(s); }

  // Read + parse the corpus (no models involved). The raw file texts are RELEASED afterwards — the
  // parsed docs are the working truth, and a resume message carries the files again if a fresh worker
  // ever needs them (review finding: retained corpus text is a pure leak once parsed).
  private fileCount = 0;
  private parse(): Doc[] {
    if (this.docs) return this.docs;
    const warns: string[] = [];
    const manifest = this.files.find((f) => f.name === "eidoscope-vault.json");
    const title = manifest ? parseVaultManifest(manifest.text)?.title : undefined;
    if (title) this.name = title;
    let docs = docsFromFiles(this.files, { warn: (l) => warns.push(l.trim()) });
    const sp = splitOversized(docs, DEFAULT_MAX_DOC_CHARS);
    docs = sp.docs;
    if (!docs.length) throw new Error("no documents found — the folder has no .md/.txt files with at least 200 characters of text");
    this.docs = docs;
    this.warnings = warns;
    this.fileCount = this.files.length;
    this.files = [];
    return docs;
  }
  warnings: string[] = [];

  // Run (or resume) as far as honesty allows. Returns the finished map, or null when stopped at the
  // axes stage for want of a key.
  async start(key: string): Promise<MapContract | null> {
    if (this.running) return null;
    this.running = true;
    const ax = axesNarration((s) => this.set(s), () => this.docs?.length ?? 0, true);
    try {
      const docs = this.parse();
      this.cardsFailed = 0;
      await this.openCaches();
      // the read line carries the honest cache-durability state (OPFS / contended / memory-only)
      this.set({ phase: "read", label: `read ${docs.length} documents from ${this.fileCount} files`, note: `${persistSummary().line} · stage times are estimated from this run's measured rates — cancel any time` });
      const llm = key ? pageLLM(key) : undefined;

      // full-text embeddings (chunk-pooled, exactly like the CLI's embedDocs) — computed once, kept
      // in-session AND in the persistent chunk cache (content+model addressed, like map.ts poolEmbed)
      const embedChunks = (label: string) => (items: { id: string; text: string }[]) => {
        const embedRate = new Rate();   // fresh slope per pass (documents vs cards embed at different sizes)
        return embedItems(items, DEFAULT_EMBED_MODEL,
          (done, total) => {
            const eta = embedRate.eta(done, total);
            this.set({ phase: "embed", label: `${label} ${done}/${total} chunks`, done, total, note: eta != null ? `≈${fmtEta(eta)} left ${label} — measured from this run's chunk rate` : `${label}: measuring the chunk rate…` });
          },
          16,
          (p: EmbedProgress) => this.set({ phase: "model", label: p.label, pct: p.pct }),
          this.embCache!);
      };
      if (!this.embeddings) {
        this.set({ phase: "model", label: "loading the embedding model…" });
        this.embeddings = await poolEmbedWith(docs.map((d) => (d.title ? d.title + ". " : "") + d.body), embedChunks("embedding documents"));
      }

      // axes: deterministic PCA + parallel analysis; the LLM only names the poles. Discovered without a
      // key the axes exist but wear PC names — re-discover WITH the llm on resume so they get named
      // (projections are seeded and identical; card cache keys use geometry, not names, so nothing re-cards).
      if (!this.axes || (llm && !this.axesNamedWithLLM)) {
        this.set({ phase: "axes", label: "discovering axes (PCA + parallel analysis)…" });
        this.axes = await discoverAxes(this.embeddings, docs.map((d) => d.title.slice(0, 64)), { llm, onProgress: ax.on });
        ax.stop();
        this.axesNamedWithLLM = !!llm;
      }
      if (!llm) {
        this.set({
          phase: "need-key",
          label: `${this.axes.axes.length} axes discovered (${this.axes.realDims} dimensions above the noise floor) from ${docs.length} documents. ` +
            `Carding needs an LLM key: the cards — one readable restatement + placements per document — are what the map is built from. ` +
            `Enter an OpenRouter API key to continue; it stays in this browser and is never written into any file.`,
        });
        return null;
      }

      const cardRate = new Rate(), regionRate = new Rate();
      const D = (await buildMap(docs, this.embeddings, {
        llm, knn: pageKnn,
        discovered: this.axes,   // discovery already ran above (deterministic) — not re-spent
        embedCardTexts: (texts) => poolEmbedWith(texts, embedChunks("embedding cards")),
        cardCache: this.cardCache!, regionCache: this.regionCache!,
        concurrency: 8,
        name: this.name,
        source: this.source ?? `folder (in-page ingest) · ${this.fileCount} files`,
        cardModel: DEFAULT_MODEL, embedderId: DEFAULT_EMBED_MODEL,
        onProgress: (p: EngineProgress) => {
          if (p.stage === "cards") {
            this.cardsFailed = p.failed;
            const eta = cardRate.eta(p.done, p.total);
            this.set({ phase: "cards", label: `writing cards ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ""}`, done: p.done, total: p.total, failed: p.failed, note: eta != null ? `≈${fmtEta(eta)} left writing cards — measured from this run's per-card rate` : "carding rate: measuring from the first cards…" });
          }
          else if (p.stage === "layout") this.set({ phase: "layout", label: `laying out ${p.cards} cards (UMAP + clustering)…` });
          else if (p.stage === "regions") {
            const eta = regionRate.eta(p.done, p.total);
            this.set({ phase: "regions", label: `naming regions ${p.done}/${p.total}`, done: p.done, total: p.total, note: eta != null ? `≈${fmtEta(eta)} left naming regions — measured from this run's naming rate` : undefined });
          }
        },
      })).D;
      // a partial pass is REPORTED, not silently mounted: the UI offers retry (caches keep every
      // written card, so a retry re-spends only the failures) or an explicit open-without-them.
      this.set({ phase: "done", label: `${D.ids.length} cards · ${D.axes.length} axes · ${D.k} regions`, failed: this.cardsFailed || undefined });
      return D;
    } finally { ax.stop(); this.running = false; }
  }
}
