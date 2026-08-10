// THE ENGINE WORKER (eid-yhj7 async engine) — every long operation the page runs (ingest, descend,
// query embedding) executes HERE, off the main thread, so the map stays pannable and no stage ever
// freezes a frame. Bundled by vite's documented worker pattern (`?worker&inline` in viewer/src/ingest.ts
// with worker.format "es" + inlineDynamicImports in vite.config.ts — one self-contained blob, which the
// singlefile build inlines like everything else). Results ferry back as transferables where large
// (MapContract.vectors / query vectors: the Float32Array buffer is TRANSFERRED, not structured-clone
// copied). Cancel is Worker.terminate() from the client — chosen over an abort signal because the time
// actually goes into onnx-wasm/WebGPU inference and tight PCA/UMAP loops that never poll a signal;
// terminate preempts them all, and the OPFS caches are append-only + content-addressed, so everything
// flushed before the kill is honestly resumable by the next run.
import { IngestRun, descendInPage, type IngestFile, type IngestStatus } from "./run";
import { embedQuery, resetEmbedder, type EmbedProgress } from "./embedder";
import type { MapContract } from "../../src/schema";

// Test seams travel from the page (where playwright's init scripts run — they do NOT run in workers)
// into this scope with each request; embedder.ts reads them from globalThis exactly as before.
export type Seams = { host?: string; wasm?: string };
const applySeams = (s?: Seams) => {
  if (s?.host) (globalThis as any).__EIDO_TF_HOST = s.host;
  if (s?.wasm) (globalThis as any).__EIDO_TF_WASM = s.wasm;
};

export type WorkerOp =
  | { op: "ingest"; runId: string; files: IngestFile[]; name: string; key: string }
  | { op: "descend"; map: MapContract; selIds: string[]; key: string }
  | { op: "embed-query"; text: string; embedderId?: string }
  | { op: "reset-embedder" };
export type WorkerReq = { id: number; seams?: Seams } & WorkerOp;
export type WorkerRes =
  | { id: number; t: "status"; s: IngestStatus }
  | { id: number; t: "embed-status"; p: EmbedProgress }
  | { id: number; t: "done"; D: MapContract | null; cardsFailed: number; warnings: string[] }
  | { id: number; t: "vec"; vec: Float32Array }
  | { id: number; t: "err"; message: string };

// Runs are kept per runId so start-again (need-key resume, retry-failures) reuses the same IngestRun —
// its in-memory embeddings/axes/deck survive between starts exactly as they did on the main thread.
const runs = new Map<string, IngestRun>();

const post = (m: WorkerRes, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? []);
// transfer the big buffer out — the worker's copy is dead after this, which is fine: the map's owner is the page
const mapTransfer = (D: MapContract | null): Transferable[] => (D?.vectors?.data?.buffer instanceof ArrayBuffer ? [D.vectors.data.buffer] : []);

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const m = ev.data; applySeams(m.seams);
  try {
    if (m.op === "ingest") {
      let run = runs.get(m.runId);
      if (!run) { run = new IngestRun(m.files, m.name, (s) => post({ id: m.id, t: "status", s })); runs.set(m.runId, run); }
      else run.onStatus = (s: IngestStatus) => post({ id: m.id, t: "status", s });
      const D = await run.start(m.key);
      post({ id: m.id, t: "done", D, cardsFailed: run.cardsFailed, warnings: run.warnings }, mapTransfer(D));
    } else if (m.op === "descend") {
      const D = await descendInPage(m.map, m.selIds, m.key, (s) => post({ id: m.id, t: "status", s }));
      post({ id: m.id, t: "done", D, cardsFailed: 0, warnings: [] }, mapTransfer(D));
    } else if (m.op === "embed-query") {
      const vec = await embedQuery(m.text, m.embedderId, (p) => post({ id: m.id, t: "embed-status", p }));
      post({ id: m.id, t: "vec", vec }, [vec.buffer as ArrayBuffer]);
    } else if (m.op === "reset-embedder") {
      resetEmbedder();
    }
  } catch (e: any) {
    post({ id: m.id, t: "err", message: String(e?.message ?? e) });
  }
};
