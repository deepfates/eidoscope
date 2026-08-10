// OPFS persistence for the page's caches (eid-yhj7) — the browser twin of src/config.ts fileStore.
// ONE cache implementation (src/llm.ts Store), two storage backends: node appends to a .jsonl file,
// the page appends to the same shape of file inside the Origin Private File System. Close the tab
// mid-ingest, reopen, re-point at the folder: every card, region name, and chunk embedding already
// paid for reloads instead of re-spending.
//
// API choice (docs read 2026-08-09, MDN): OPFS has two write paths — createSyncAccessHandle (workers
// only; Safari 15.2+) and createWritable (main thread; Chrome 86+, Firefox 111+, Safari 18.2+ — it
// landed in Baseline Sept 2025). We use plain createWritable on the main thread: no worker, no wrapper
// library (the raw API is already thinner than any wrapper), at the cost that pre-18.2 Safari gets the
// session-memory fallback. createWritable commits ONLY on close() (it writes a temp file and swaps),
// so appends are batched per flush: keepExistingData + seek(EOF) + write + close.
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
    if (typeof fh.createWritable !== "function") return null;   // Safari < 18.2 main thread
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
export async function opfsStore(name: string): Promise<Store> {
  const p = await opfsPersist(name);
  if (!p) warnOnce();
  return new Store(p ?? undefined);
}

// Filenames carry the model id the way node's EmbeddingCache does (one file per embedder).
export const cacheFileName = (base: string, model?: string) =>
  model ? `${base}-${model.replace(/[^a-zA-Z0-9._-]+/g, "_")}.jsonl` : `${base}.jsonl`;
