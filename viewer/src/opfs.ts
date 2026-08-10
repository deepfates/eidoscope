// OPFS persistence for the page's caches (eid-yhj7) — the browser twin of src/config.ts fileStore.
// ONE cache implementation (src/llm.ts Store), two storage backends: node appends to a .jsonl file,
// the page appends to the same shape of file inside the Origin Private File System. Close the tab
// mid-ingest, reopen, re-point at the folder: every card, region name, and chunk embedding already
// paid for reloads instead of re-spending.
//
// API choice (docs read 2026-08-09, MDN; revisited 2026-08-09 for the async engine): OPFS has two
// write paths — createSyncAccessHandle (WORKERS ONLY; Safari 15.2+) and createWritable (Chrome 86+,
// Firefox 111+, Safari 18.2+). Since eid-yhj7 the caches are opened inside the engine Web Worker, so
// the PREFERRED path is the sync access handle: read once at open, then each append is a synchronous
// write-at-offset + flush — no temp-file swap, no promise chain, and crash/terminate-safe (everything
// flushed is on disk; the exclusive lock is released when the worker is destroyed). createWritable
// stays as the fallback for any non-worker caller (it commits ONLY on close() — temp file + swap — so
// its appends are batched per flush: keepExistingData + seek(EOF) + write + close).
//
// Feature-detect, never throw: no getDirectory / no createWritable / any OPFS error → the Store runs
// with today's session-memory behavior, and ONE honest console line says so.
import { Store, type StorePersist } from "../../src/llm";

const DIR = "eido-cache";
let warned = false;
const warnOnce = () => {
  if (warned) return; warned = true;
  console.info("eidoscope: OPFS persistence unavailable in this browser — cached work (cards, embeddings, region names) lives only in this tab; a reload re-pays it.");
};

// Build a StorePersist over one OPFS file, or null when the platform can't. Appends are queued and
// serialized on a promise chain: lines arriving while a write is in flight coalesce into the next
// write, so bursts (a carding pass at concurrency 8) cost few createWritable cycles, and the chain
// keeps writes ordered. A failed write disables persistence for the rest of the session (memory keeps
// working) rather than throwing into the ingest.
async function opfsPersist(name: string): Promise<StorePersist | null> {
  try {
    const nav: any = (globalThis as any).navigator;
    if (!nav?.storage?.getDirectory) return null;
    const root = await nav.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const fh: any = await dir.getFileHandle(name, { create: true });
    // worker path: the sync access handle (worker-only API — gate on actually being in a worker scope)
    const inWorker = typeof (globalThis as any).WorkerGlobalScope !== "undefined" && globalThis instanceof (globalThis as any).WorkerGlobalScope;
    if (inWorker && typeof fh.createSyncAccessHandle === "function") {
      const h = await fh.createSyncAccessHandle();
      const size0: number = h.getSize();
      const buf = new Uint8Array(size0);
      if (size0) h.read(buf, { at: 0 });
      const initial = new TextDecoder().decode(buf);
      let at = size0;
      let dead = false;
      return {
        read: () => initial || undefined,
        append: (line) => {
          if (dead) return;
          try { const b = new TextEncoder().encode(line); h.write(b, { at }); at += b.byteLength; h.flush(); }
          catch { dead = true; warnOnce(); }
        },
      };
    }
    if (typeof fh.createWritable !== "function") return null;   // Safari < 18.2 outside a worker
    const file: File = await fh.getFile();
    const initial = await file.text();
    let size = file.size;                                       // bytes (≠ chars for multibyte text)
    let pending: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    let dead = false;
    const flush = () => {
      chain = chain.then(async () => {
        if (dead || !pending.length) return;
        const lines = pending; pending = [];
        const buf = new TextEncoder().encode(lines.join(""));
        const w = await fh.createWritable({ keepExistingData: true });
        await w.seek(size);
        await w.write(buf);
        await w.close();                                        // commit point (temp-file swap)
        size += buf.byteLength;
      }).catch(() => { dead = true; pending = []; warnOnce(); });
    };
    return {
      read: () => initial || undefined,
      append: (line) => { if (dead) return; pending.push(line); flush(); },
    };
  } catch { return null; }
}

// A Store persisted in OPFS when the browser can, session-memory (with one honest line) when it can't.
// ONE Store per filename per scope (memoized): the sync access handle holds an exclusive lock for the
// worker's lifetime, so a second open of the same file (ingest and descend both use the regions cache)
// must share the instance, not race the lock into the memory fallback.
const stores = new Map<string, Promise<Store>>();
export function opfsStore(name: string): Promise<Store> {
  let p = stores.get(name);
  if (!p) {
    p = opfsPersist(name).then((persist) => { if (!persist) warnOnce(); return new Store(persist ?? undefined); });
    stores.set(name, p);
  }
  return p;
}

// Filenames carry the model id the way node's EmbeddingCache does (one file per embedder).
export const cacheFileName = (base: string, model?: string) =>
  model ? `${base}-${model.replace(/[^a-zA-Z0-9._-]+/g, "_")}.jsonl` : `${base}.jsonl`;
