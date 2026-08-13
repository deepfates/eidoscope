// THE ENGINE WORKER (eid-yhj7 async engine) — every long operation the page runs (ingest, descend,
// query embedding) executes HERE, off the main thread, so the map stays pannable and no stage ever
// freezes a frame. Bundled by vite's documented worker pattern (`?worker&inline` in viewer/src/ingest.ts
// with worker.format "es" + inlineDynamicImports in vite.config.ts — one self-contained blob, which the
// singlefile build inlines like everything else).
//
// OWNERSHIP (review finding 4): the client spawns ONE WORKER PER OPERATION CLASS — a worker per ingest
// run (alive across need-key/retry resumes of that run), a worker per descend, one persistent worker
// for query embeds. So cancel is exact — terminating a worker kills exactly its own operation — and
// no two operations ever share a thread or a status stream. This file is the same script in every
// role; each instance only ever receives its owner's requests.
//
// RESULTS cross as the .eido CONTAINER (src/eido-container.ts — the ONE shared codec): a single
// Uint8Array, transferred (zero-copy), decoded on the main thread by the same decodeContainer a
// dropped file uses. No large object graphs are ever structured-cloned out of the worker. Cancel is
// Worker.terminate() — the time goes into onnx-wasm/WebGPU inference and tight PCA/UMAP loops that
// never poll an abort signal; the OPFS caches are append-only + content-addressed (and DRAINED before
// any result posts), so everything flushed before a kill is honestly resumable.
import { IngestRun, descendInPage, type IngestFile, type IngestStatus } from "./run";
import type { Compute } from "./compute";
import { embedQuery, type EmbedProgress } from "./embedder";
import { encodeContainer } from "../../src/eido-container";
import { opfsDrain } from "./opfs";
import type { DescendParent } from "../../src/engine";
import type { MapContract } from "../../src/schema";

// Test seams travel from the page (where playwright's init scripts run — they do NOT run in workers)
// into this scope with each request; embedder.ts reads them from globalThis exactly as before.
export type Seams = { host?: string; wasm?: string };
const applySeams = (s?: Seams) => {
  if (s?.host) (globalThis as any).__EIDO_TF_HOST = s.host;
  if (s?.wasm) (globalThis as any).__EIDO_TF_WASM = s.wasm;
};

export type WorkerOp =
  | { op: "ingest"; runId: string; files: IngestFile[]; name: string; compute: Compute; source?: string }
  | { op: "descend"; map: DescendParent; selIds: string[]; compute: Compute }
  | { op: "embed-query"; text: string; embedderId?: string }
  | { op: "dispose" };   // graceful shutdown: self.close() tears the (large wasm) heap down ON THIS thread
export type WorkerReq = { id: number; seams?: Seams } & WorkerOp;
export type WorkerRes =
  | { id: number; t: "status"; s: IngestStatus }
  | { id: number; t: "embed-status"; p: EmbedProgress }
  | { id: number; t: "done"; bytes: Uint8Array | null; cardsFailed: number; warnings: string[] }
  | { id: number; t: "vec"; vec: Float32Array }
  | { id: number; t: "err"; message: string };

// One IngestRun per runId — and ONLY while resume genuinely needs it (review finding 2): kept through
// the need-key gate and a failed-cards partial (both are the panel explicitly waiting to resume with
// warm in-memory state), DELETED on clean completion and on error. The durable resume state is the
// OPFS caches; in-memory duplication after the run ends is a pure leak.
const runs = new Map<string, IngestRun>();

const post = (m: WorkerRes, transfer?: Transferable[]) => (self as any).postMessage(m, transfer ?? []);

// encode → drain caches → post one transferred buffer. Encoding through the shared container codec is
// exactly what view.save does in-page; the main thread decodes with the same decodeContainer a dropped
// .eido uses, so nothing big is ever structured-cloned.
const postMap = async (id: number, D: MapContract | null, cardsFailed: number, warnings: string[]) => {
  const bytes = D ? encodeContainer(D) : null;
  await opfsDrain();   // a client that terminates this worker right after "done" cuts nothing off the cache files
  post({ id, t: "done", bytes, cardsFailed, warnings }, bytes ? [bytes.buffer as ArrayBuffer] : []);
};

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const m = ev.data; applySeams(m.seams);
  try {
    if (m.op === "dispose") {
      // MEASURED (probe3, 2026-08-09): main-thread Worker.terminate() of a worker holding the warmed
      // onnx-wasm heap blocked the page for ~1.3s. self.close() runs the teardown HERE instead — the
      // client only hard-terminates for cancel/error, where preemption is the whole point.
      (self as any).close();
    } else if (m.op === "ingest") {
      let run = runs.get(m.runId);
      if (!run) { run = new IngestRun(m.files, m.name, (s) => post({ id: m.id, t: "status", s }), m.source); runs.set(m.runId, run); }
      else run.onStatus = (s: IngestStatus) => post({ id: m.id, t: "status", s });
      try {
        const D = await run.start(m.compute);
        if (D && !run.cardsFailed) runs.delete(m.runId);   // clean completion: nothing left to resume
        await postMap(m.id, D, run.cardsFailed, run.warnings);
      } catch (e) { runs.delete(m.runId); throw e; }        // failure: OPFS is the resume state
    } else if (m.op === "descend") {
      const D = await descendInPage(m.map, m.selIds, m.compute, (s) => post({ id: m.id, t: "status", s }));
      await postMap(m.id, D, 0, []);
    } else if (m.op === "embed-query") {
      const vec = await embedQuery(m.text, m.embedderId, (p) => post({ id: m.id, t: "embed-status", p }));
      post({ id: m.id, t: "vec", vec }, [vec.buffer as ArrayBuffer]);
    }
  } catch (e: any) {
    post({ id: m.id, t: "err", message: String(e?.message ?? e) });
  }
};
