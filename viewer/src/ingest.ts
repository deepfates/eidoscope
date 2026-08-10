// MAIN-THREAD FACE of the async engine (eid-yhj7): folder collection, the user-held key, and the
// ENGINE CLIENT — a thin postMessage bridge to viewer/src/engine.worker.ts, where every long operation
// (ingest, descend, query embedding) actually runs. Nothing heavy is imported here: the engine, ax and
// transformers.js live only in the worker bundle, so the main thread's job during a run is to paint
// progress and keep the current map interactive. Cancel really cancels: the client terminates the
// worker (see engine.worker.ts for why terminate beats an abort signal here) and the next run resumes
// from the OPFS caches.
import type { MapContract } from "../../src/schema";
import type { IngestFile, IngestStatus } from "./run";
import type { EmbedProgress } from "./embedder";
import type { WorkerOp, WorkerReq, WorkerRes, Seams } from "./engine.worker";
import EngineWorker from "./engine.worker?worker&inline";

export type { IngestFile, IngestStatus };

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

// ── the engine client: one lazy worker, promise-per-request, streamed status ────────────────────────
export class CancelledError extends Error { constructor() { super("cancelled"); } }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onStatus?: (s: IngestStatus) => void; onEmbed?: (p: EmbedProgress) => void };

let w: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

// the e2e seams are set on the PAGE by playwright init scripts (which never run inside workers) — the
// client forwards them with every request so the worker's embedder sees them before first load.
const seams = (): Seams | undefined => {
  const host = (globalThis as any).__EIDO_TF_HOST, wasm = (globalThis as any).__EIDO_TF_WASM;
  return host || wasm ? { host, wasm } : undefined;
};

function worker(): Worker {
  if (w) return w;
  w = new EngineWorker();
  w.onmessage = (ev: MessageEvent<WorkerRes>) => {
    const m = ev.data, p = pending.get(m.id);
    if (!p) return;
    if (m.t === "status") p.onStatus?.(m.s);
    else if (m.t === "embed-status") p.onEmbed?.(m.p);
    else if (m.t === "err") { pending.delete(m.id); p.reject(new Error(m.message)); }
    else { pending.delete(m.id); p.resolve(m); }
  };
  w.onerror = (e) => rejectAll(new Error("engine worker error: " + (e?.message ?? e)));
  return w;
}
const rejectAll = (err: Error) => { for (const p of pending.values()) p.reject(err); pending.clear(); };

function call<T>(req: WorkerOp, hooks: Omit<Pending, "resolve" | "reject"> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, ...hooks });
    worker().postMessage({ ...req, id, seams: seams() } as WorkerReq);
  });
}

export type IngestResult = { D: MapContract | null; cardsFailed: number; warnings: string[] };

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

export const engine = {
  // Run (or resume — same runId) one folder's ingest in the worker. Resolves null D at the key gate.
  ingest(runId: string, files: IngestFile[], name: string, key: string, onStatus: (s: IngestStatus) => void): Promise<IngestResult> {
    return call<IngestResult>({ op: "ingest", runId, files: toPlain(files), name, key }, { onStatus });
  },
  // DESCEND the held set into its own map. The parent map is structured-cloned INTO the worker (its
  // vectors stay owned by the page); the child's vectors are transferred back, zero-copy.
  descend(map: MapContract, selIds: string[], key: string, onStatus: (s: IngestStatus) => void): Promise<MapContract> {
    return call<{ D: MapContract }>({ op: "descend", map: toPlain(map), selIds: toPlain(selIds), key }, { onStatus }).then((r) => r.D);
  },
  // Embed one semantic query with the SAME worker-resident model the ingest uses — the one-off embed
  // rides the same bridge rather than loading a second 23MB model on the main thread.
  embedQuery(text: string, embedderId: string | undefined, onEmbed: (p: EmbedProgress) => void): Promise<Float32Array> {
    return call<{ vec: Float32Array }>({ op: "embed-query", text, embedderId }, { onEmbed }).then((r) => r.vec);
  },
  // Drop the worker's cached extractor so the next embed refetches cleanly (after a stalled download).
  resetEmbedder(): void { if (w) w.postMessage({ op: "reset-embedder", id: ++seq } as WorkerReq); },
  // CANCEL: terminate the worker (preempts wasm/GPU inference and tight math loops mid-flight — nothing
  // in that stack polls an abort signal) and fail every in-flight promise. OPFS cache lines already
  // flushed survive, so a re-run of the same folder resumes instead of re-spending.
  cancel(): void { if (w) { w.terminate(); w = null; } rejectAll(new CancelledError()); },
  busy(): boolean { return pending.size > 0; },
};
