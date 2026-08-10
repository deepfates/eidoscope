// MAIN-THREAD FACE of the async engine (eid-yhj7): folder collection, the user-held key, and the
// ENGINE CLIENT — worker spawning, ownership and the postMessage bridge to viewer/src/engine.worker.ts,
// where every long operation (ingest, descend, query embedding) actually runs. Nothing heavy is
// imported here: engine, ax and transformers.js live only in the worker bundle.
//
// OWNERSHIP (one worker per operation class — review finding 4): each ingest RUN owns a worker (alive
// across need-key/retry resumes, terminated on clean completion, cancel, or error), each descend owns
// a short-lived worker, and query embeds share one persistent worker (it holds the warmed model).
// cancelIngest(runId) therefore terminates exactly that run — never a query or a descend in flight.
// A worker whose health is unknown (onerror / onmessageerror / clone failure) is REJECTED-AND-RECYCLED:
// every pending promise on it fails and the worker is discarded, never reused (review finding 5).
//
// RESULTS cross as the encoded .eido container (one transferred buffer — no big structured clones,
// review finding 3) and are decoded here by the SAME decodeContainer/EmbeddedStore a dropped file uses.
import { EmbeddedStore, type Store as MapStore } from "../../src/store";
import { decodeContainerAsync } from "../../src/eido-container";
import type { DescendParent } from "../../src/engine";
import type { MapContract } from "../../src/schema";
import type { IngestFile, IngestStatus } from "./run";
import type { EmbedProgress } from "./embedder";
import type { WorkerOp, WorkerReq, WorkerRes, Seams } from "./engine.worker";
import EngineWorker from "./engine.worker?worker&inline";

export type { IngestFile, IngestStatus };
// the connectors' pre-download guard (see src/defaults.ts — the ingest-RUN refusal is dead, this
// bounds only what a connector will pull into the page when the row count is known up front)
export { INPAGE_ENVELOPE_DOCS } from "../../src/defaults";

// ── the user-held LLM key: a field the user fills, kept in localStorage, never in any file ───────────
export const KEY_STORAGE = "eido-llm-key";
export const getKey = (): string => { try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; } };
export const setKey = (k: string): void => { try { k ? localStorage.setItem(KEY_STORAGE, k) : localStorage.removeItem(KEY_STORAGE); } catch {} };

// ── collecting the folder's files (picker or drop) ──────────────────────────────────────────────────
import { SOURCE_EXT } from "../../src/corpus-core";

const readTexts = async (files: File[]): Promise<IngestFile[]> => {
  const out: IngestFile[] = [];
  for (const f of files) {
    if (!SOURCE_EXT.test(f.name) && f.name !== "eidoscope-vault.json") continue;
    // file mtime → a temporal "modified" column (eid-xmf0). ISO string, not epoch number: buildCols
    // infers temporal from date-shaped strings (a bare number would honestly read as a scalar).
    const meta = f.lastModified ? { modified: new Date(f.lastModified).toISOString() } : undefined;
    out.push({ path: (f as any).webkitRelativePath || f.name, name: f.name, text: await f.text(), ...(meta ? { meta } : {}) });
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

// ── the engine client ───────────────────────────────────────────────────────────────────────────────
export class CancelledError extends Error { constructor() { super("cancelled"); } }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onStatus?: (s: IngestStatus) => void; onEmbed?: (p: EmbedProgress) => void };

// the e2e seams are set on the PAGE by playwright init scripts (which never run inside workers) — the
// client forwards them with every request so the worker's embedder sees them before first load.
const seams = (): Seams | undefined => {
  const host = (globalThis as any).__EIDO_TF_HOST, wasm = (globalThis as any).__EIDO_TF_WASM;
  return host || wasm ? { host, wasm } : undefined;
};

let seq = 0;

// One worker + its in-flight requests. terminate() rejects everything and discards the worker; any
// signal that its health is unknown (onerror / onmessageerror / clone failure) does the same — a
// possibly-dead worker is never reused.
class Bridge {
  private w: Worker;
  private pending = new Map<number, Pending>();
  dead = false;
  constructor() {
    this.w = new EngineWorker();
    this.w.onmessage = (ev: MessageEvent<WorkerRes>) => {
      const m = ev.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.t === "status") p.onStatus?.(m.s);
      else if (m.t === "embed-status") p.onEmbed?.(m.p);
      else if (m.t === "err") { this.pending.delete(m.id); p.reject(new Error(m.message)); }
      else { this.pending.delete(m.id); p.resolve(m); }
    };
    this.w.onerror = (e: any) => this.terminate(new Error("engine worker error: " + (e?.message ?? e)));
    this.w.onmessageerror = () => this.terminate(new Error("engine worker message could not be deserialized"));
  }
  call<T>(req: WorkerOp, hooks: Omit<Pending, "resolve" | "reject"> = {}, transfer?: Transferable[]): Promise<T> {
    if (this.dead) return Promise.reject(new Error("engine worker is gone — retry to spawn a fresh one"));
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...hooks });
      // a send/clone failure means the bridge's health is unknown — recycle it (terminate rejects every
      // pending request, INCLUDING this one, which is already registered above), never reuse it
      try { this.w.postMessage({ ...req, id, seams: seams() } as WorkerReq, transfer ?? []); }
      catch (e: any) { this.terminate(new Error("could not send to the engine worker — recycled it: " + (e?.message ?? e))); }
    });
  }
  terminate(err: Error = new CancelledError()) {
    if (this.dead) return;
    this.dead = true;
    this.w.terminate();
    const ps = [...this.pending.values()]; this.pending.clear();
    ps.forEach((p) => p.reject(err));
  }
  // graceful shutdown for an IDLE worker: the worker closes ITSELF (self.close()), so the teardown of
  // its (potentially huge) wasm heap runs on its own thread. Measured: main-thread terminate() of a
  // warmed engine worker blocked the page ~1.3s — exactly the freeze this architecture exists to kill.
  dispose() {
    if (this.dead) return;
    this.dead = true;
    try { this.w.postMessage({ op: "dispose", id: ++seq } as WorkerReq); } catch { this.w.terminate(); }
    const ps = [...this.pending.values()]; this.pending.clear();
    ps.forEach((p) => p.reject(new CancelledError()));
  }
}

// decode COOPERATIVELY: the container expansion yields to the event loop between chunks, so a large
// result never lands as one long main-thread task at completion (review round 2, finding 3).
const decode = async (bytes: Uint8Array): Promise<MapStore> => new EmbeddedStore(await decodeContainerAsync(bytes));

// Deep-materialize before postMessage: the app hands svelte $state proxies (structured clone throws
// "could not be cloned" on them); plain property reads unwrap every proxy while typed arrays pass
// through untouched (svelte never proxies them, and clone handles them natively).
const toPlain = (v: any): any => {
  if (v == null || typeof v !== "object" || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  if (Array.isArray(v)) return v.map(toPlain);
  const o: any = {};
  for (const k of Object.keys(v)) o[k] = toPlain(v[k]);
  return o;
};

export type IngestResult = { store: MapStore | null; cardsFailed: number; warnings: string[] };
type DoneMsg = { bytes: Uint8Array | null; cardsFailed: number; warnings: string[] };

const ingestBridges = new Map<string, Bridge>();
let embedBridge: Bridge | null = null;

export const engine = {
  // Run (or resume — same runId, same worker, warm state) one folder's ingest. Resolves a null store
  // at the key gate. The run's worker dies on clean completion or error (OPFS is the durable resume
  // state); it survives need-key and failed-cards partials, which the panel resumes in place.
  // `source` = which connector this corpus truthfully came through (connectors/types.ts, from main's
  // HF connector) — rides to the worker's IngestRun and lands in provenance.source.
  async ingest(runId: string, files: IngestFile[], name: string, key: string, onStatus: (s: IngestStatus) => void, source?: string): Promise<IngestResult> {
    let b = ingestBridges.get(runId);
    if (!b || b.dead) { b = new Bridge(); ingestBridges.set(runId, b); }
    try {
      const r = await b.call<DoneMsg>({ op: "ingest", runId, files: toPlain(files), name, key, source }, { onStatus });
      const complete = !!r.bytes && r.cardsFailed === 0;
      if (complete) { b.dispose(); ingestBridges.delete(runId); }
      return { store: r.bytes ? await decode(r.bytes) : null, cardsFailed: r.cardsFailed, warnings: r.warnings };
    } catch (e) {
      if (!(e instanceof CancelledError)) { b.terminate(e as Error); ingestBridges.delete(runId); }
      throw e;
    }
  },
  // CANCEL exactly this run: terminate ITS worker (preempts wasm/GPU inference and tight math loops —
  // nothing in that stack polls an abort signal). Cache lines already flushed to OPFS survive, so a
  // re-run of the same folder resumes instead of re-spending.
  cancelIngest(runId: string): void {
    const b = ingestBridges.get(runId);
    if (b) { b.terminate(); ingestBridges.delete(runId); }
  },
  // DESCEND the held set into its own map — a fresh worker per call, gone when the call settles.
  // Inbound crosses ONLY what descend reads (engine.ts DescendParent): identity, cards, metadata and
  // one copied vectors buffer (transferred) — the parent's heavy geometry never crosses at all.
  async descend(map: MapContract, selIds: string[], key: string, onStatus: (s: IngestStatus) => void): Promise<MapStore> {
    const parent: DescendParent = {
      ids: toPlain(map.ids), titles: toPlain(map.titles), cores: toPlain(map.cores),
      vectors: map.vectors ? { data: new Float32Array(map.vectors.data), dim: map.vectors.dim } : undefined,
      cite: toPlain(map.cite), citec: toPlain(map.citec),
      urls: toPlain(map.urls), sources: toPlain(map.sources), siteNames: toPlain(map.siteNames),
      authors: toPlain(map.authors), tags: toPlain(map.tags), dates: toPlain(map.dates),
      read: toPlain(map.read), folders: toPlain(map.folders), cols: toPlain(map.cols),
      provenance: toPlain(map.provenance), derivedBy: toPlain(map.derivedBy),
    };
    const b = new Bridge();
    try {
      const r = await b.call<DoneMsg>({ op: "descend", map: parent, selIds: toPlain(selIds), key }, { onStatus },
        parent.vectors ? [parent.vectors.data.buffer as ArrayBuffer] : []);
      b.dispose();   // graceful: the worker closes itself (its heap teardown never blocks the page)
      return await decode(r.bytes!);
    } catch (e) { b.terminate(e as Error); throw e; }
  },
  // Embed one semantic query on the persistent embed worker (it keeps the warmed model between queries).
  embedQuery(text: string, embedderId: string | undefined, onEmbed: (p: EmbedProgress) => void): Promise<Float32Array> {
    if (!embedBridge || embedBridge.dead) embedBridge = new Bridge();
    return embedBridge.call<{ vec: Float32Array }>({ op: "embed-query", text, embedderId }, { onEmbed }).then((r) => r.vec);
  },
  // A stalled/poisoned embed: terminate the embed worker (aborting its hung download for real) — the
  // next query spawns a clean one. Exact ownership: ingest and descend workers are untouched.
  resetEmbedder(): void {
    if (embedBridge) { embedBridge.terminate(); embedBridge = null; }
  },
};
