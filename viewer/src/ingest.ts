// IN-PAGE INGEST (eid-bacg) — folder → map, entirely in the tab. This is the page FACE of the ONE
// engine (src/engine.ts): the stages (parse → embed full text → discover axes → card → embed cards →
// project+cluster → name regions → assemble) are the shared host-free modules; this file only binds
// them to the browser host — File objects instead of fs, transformers.js as the embedder, an OpenRouter
// client built from the user-held key (fetch straight from the page; CORS allow-origin:* measured
// 2026-08-09), and session-memory caches (which make a partial run RESUMABLE: retry re-runs failures only).
import { ai } from "@ax-llm/ax";
import { docsFromFiles, splitOversized, parseVaultManifest, SOURCE_EXT, type Doc } from "../../src/corpus-core";
import { buildMap, type EngineProgress } from "../../src/engine";
import { poolEmbedWith } from "../../src/geometry";
import { discoverAxes, type Axis } from "../../src/axes";
import { Store } from "../../src/llm";
import { DEFAULT_MODEL, DEFAULT_API_URL, DEFAULT_EMBED_MODEL, DEFAULT_MAX_DOC_CHARS, INPAGE_ENVELOPE_DOCS } from "../../src/defaults";
import type { MapContract } from "../../src/schema";
import { embedItems, type EmbedProgress } from "./semantic";

export { INPAGE_ENVELOPE_DOCS };

// ── the user-held LLM key: a field the user fills, kept in localStorage, never in any file ───────────
export const KEY_STORAGE = "eido-llm-key";
export const getKey = (): string => { try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; } };
export const setKey = (k: string): void => { try { k ? localStorage.setItem(KEY_STORAGE, k) : localStorage.removeItem(KEY_STORAGE); } catch {} };

export const pageLLM = (key: string) =>
  ai({ name: "openai", apiKey: key, apiURL: DEFAULT_API_URL, config: { model: DEFAULT_MODEL, stream: false } } as any);

// ── collecting the folder's files (picker or drop) ──────────────────────────────────────────────────
export type IngestFile = { path: string; name: string; text: string };

const readTexts = async (files: File[]): Promise<IngestFile[]> => {
  const out: IngestFile[] = [];
  for (const f of files) {
    if (!SOURCE_EXT.test(f.name) && f.name !== "eidoscope-vault.json") continue;
    out.push({ path: (f as any).webkitRelativePath || f.name, name: f.name, text: await f.text() });
  }
  return out;
};

// <input webkitdirectory> hands a flat FileList with webkitRelativePath set.
export async function filesFromFileList(list: FileList | File[]): Promise<IngestFile[]> {
  return readTexts([...list]);
}

// Drag-a-folder: walk the dropped DataTransfer's directory entries recursively.
export async function filesFromDataTransfer(dt: DataTransfer): Promise<IngestFile[]> {
  const files: File[] = [];
  const walkEntry = (entry: any, prefix: string): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) entry.file((f: File) => { Object.defineProperty(f, "webkitRelativePath", { value: prefix + f.name }); files.push(f); resolve(); }, () => resolve());
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all: any[] = [];
        const read = () => reader.readEntries(async (es: any[]) => {
          if (es.length) { all.push(...es); read(); }
          else { for (const e of all) await walkEntry(e, prefix + entry.name + "/"); resolve(); }
        }, () => resolve());
        read();
      } else resolve();
    });
  const items = [...(dt.items ?? [])];
  const entries = items.map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) { for (const e of entries) await walkEntry(e, ""); }
  else files.push(...[...(dt.files ?? [])]);
  return readTexts(files);
}

// ── the run: honest per-stage progress, resumable within the session ────────────────────────────────
export type IngestStatus = {
  phase: "read" | "model" | "embed" | "axes" | "need-key" | "cards" | "embed-cards" | "layout" | "regions" | "done" | "error";
  label: string;
  done?: number; total?: number; failed?: number; pct?: number;
};

export class EnvelopeError extends Error {}

// One ingest of one folder. `start(key)` runs as far as it honestly can — with no key it stops after
// the axes stage (the card is the bottleneck AND the point: without a key there are no cards, so no
// map; we say so instead of shipping a cardless fake). Calling start again (same run) RESUMES: the
// full-text embeddings, discovered geometry and every already-written card are kept in session caches,
// so only failures and the not-yet-done stages spend anything.
export class IngestRun {
  status: IngestStatus = { phase: "read", label: "reading files…" };
  private docs: Doc[] | null = null;
  private embeddings: number[][] | null = null;
  private axesNamedWithLLM = false;
  private axes: { axes: Axis[]; realDims: number; projections: number[][] } | null = null;
  private cardCache = new Store();     // session-memory: resumability inside the run
  private regionCache = new Store();
  cardsFailed = 0;                     // failures in the LAST carding pass (a retry re-runs only these)
  running = false;

  constructor(
    public files: IngestFile[],
    public name: string,
    private onStatus: (s: IngestStatus) => void,
  ) {}

  private set(s: IngestStatus) { this.status = s; this.onStatus(s); }

  // Read + parse + envelope-check the corpus (no models involved). Throws EnvelopeError past the limit.
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
    // Envelope guard (docs/ARCHITECTURE.md): in-page is comfortable to ~2–5k docs (measured: the 5k-doc
    // layout itself is 2.9s in-browser; the wall is embed+card time). Past that, refuse honestly.
    if (docs.length > INPAGE_ENVELOPE_DOCS) throw new EnvelopeError(
      `${docs.length.toLocaleString()} documents is past the in-page envelope (~${INPAGE_ENVELOPE_DOCS.toLocaleString()}). ` +
      `Build this one with the CLI twin — \`eidoscope <folder>\` — and open the .eido it emits here; same engine, same file.`);
    this.docs = docs;
    this.warnings = warns;
    return docs;
  }
  warnings: string[] = [];

  // Run (or resume) as far as honesty allows. Returns the finished map, or null when stopped at the
  // axes stage for want of a key.
  async start(key: string): Promise<MapContract | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const docs = this.parse();
      this.cardsFailed = 0;
      const llm = key ? pageLLM(key) : undefined;

      // full-text embeddings (chunk-pooled, exactly like the CLI's embedDocs) — computed once, kept
      const embedChunks = (label: string) => (items: { id: string; text: string }[]) =>
        embedItems(items, DEFAULT_EMBED_MODEL,
          (done, total) => this.set({ phase: "embed", label: `${label} ${done}/${total} chunks`, done, total }),
          16,
          (p: EmbedProgress) => this.set({ phase: "model", label: p.label, pct: p.pct }));
      if (!this.embeddings) {
        this.set({ phase: "model", label: "loading the embedding model…" });
        this.embeddings = await poolEmbedWith(docs.map((d) => (d.title ? d.title + ". " : "") + d.body), embedChunks("embedding documents"));
      }

      // axes: deterministic PCA + parallel analysis; the LLM only names the poles. Discovered without a
      // key the axes exist but wear PC names — re-discover WITH the llm on resume so they get named
      // (projections are seeded and identical; card cache keys use geometry, not names, so nothing re-cards).
      if (!this.axes || (llm && !this.axesNamedWithLLM)) {
        this.set({ phase: "axes", label: "discovering axes (PCA + parallel analysis)…" });
        this.axes = await discoverAxes(this.embeddings, docs.map((d) => d.title.slice(0, 64)), { llm });
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

      const D = (await buildMap(docs, this.embeddings, {
        llm,
        discovered: this.axes,   // discovery already ran above (deterministic) — not re-spent
        embedCardTexts: (texts) => poolEmbedWith(texts, embedChunks("embedding cards")),
        cardCache: this.cardCache, regionCache: this.regionCache,
        concurrency: 8,
        name: this.name,
        source: `folder (in-page ingest) · ${this.files.length} files`,
        cardModel: DEFAULT_MODEL, embedderId: DEFAULT_EMBED_MODEL,
        onProgress: (p: EngineProgress) => {
          if (p.stage === "cards") { this.cardsFailed = p.failed; this.set({ phase: "cards", label: `writing cards ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ""}`, done: p.done, total: p.total, failed: p.failed }); }
          else if (p.stage === "layout") this.set({ phase: "layout", label: `laying out ${p.cards} cards (UMAP + clustering)…` });
          else if (p.stage === "regions") this.set({ phase: "regions", label: `naming regions ${p.done}/${p.total}`, done: p.done, total: p.total });
        },
      })).D;
      // a partial pass is REPORTED, not silently mounted: the UI offers retry (session caches keep every
      // written card, so a retry re-spends only the failures) or an explicit open-without-them.
      this.set({ phase: "done", label: `${D.ids.length} cards · ${D.axes.length} axes · ${D.k} regions`, failed: this.cardsFailed || undefined });
      return D;
    } finally { this.running = false; }
  }
}
