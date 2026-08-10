// OPFS persistence for the page's caches (eid-yhj7) — the browser twin of src/config.ts fileStore.
// ONE cache implementation (src/llm.ts Store), two storage backends: node appends to a .jsonl file,
// the page appends to the same shape of file inside the Origin Private File System. Close the tab
// mid-ingest, reopen, re-point at the folder: every card, region name, and chunk embedding already
// paid for reloads instead of re-spending.
//
// API choice (docs read 2026-08-09, MDN; reworked after review): OPFS has two write paths —
// createSyncAccessHandle (WORKERS ONLY; Safari 15.2+) and createWritable (Chrome 86+, Firefox 111+,
// Safari 18.2+). The engine worker uses the sync handle, but acquired PER FLUSH, not held for the
// worker's lifetime: the handle's lock is exclusive across tabs, so holding it would silently demote
// every other tab to memory-only. Each flush is acquire (with backoff — another tab may be mid-flush)
// → write-at-EOF looping on the RETURNED byte counts → flush → close (lock released). Contention is
// therefore transient by construction: lines queue and the flush retries; nothing is ever permanently
// demoted. createWritable stays as the fallback outside workers (it commits ONLY on close() — temp
// file + swap — so its appends are batched per flush).
//
// Torn writes: a terminate (cancel is Worker.terminate) can land mid-write. On open, any trailing
// bytes after the last "\n" are held OUT of the initial read (the loader never sees a torn tail), and
// the next flush first seals the file with a "\n" so the torn fragment becomes one malformed line —
// which src/llm.ts Store counts and warns about instead of silently dropping.
//
// Feature-detect, never throw: no getDirectory / any OPFS error → the Store runs with session-memory
// behavior, one honest console line says so, and persistSummary() lets the UI say it too.
import { Store, type StorePersist } from "../../src/llm";

const DIR = "eido-cache";
let warned = false;
const warnOnce = () => {
  if (warned) return; warned = true;
  console.info("eidoscope: OPFS persistence unavailable in this browser — cached work (cards, embeddings, region names) lives only in this tab; a reload re-pays it.");
};

// honest cache-durability state, per file — surfaced in the ingest panel's status line
export type PersistMode = "opfs" | "contended" | "memory";
const modes = new Map<string, PersistMode>();
export function persistSummary(): { mode: PersistMode; line: string } {
  const all = [...modes.values()];
  const mode: PersistMode = all.includes("memory") ? "memory" : all.includes("contended") ? "contended" : "opfs";
  const line = mode === "opfs" ? "caches persist in this browser (OPFS)"
    : mode === "contended" ? "caches: another tab holds the cache file — queued writes will persist when it lets go"
    : "caches: memory only in this browser — a reload re-pays uncached work";
  return { mode, line };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NL = 10; // "\n"

// Acquire the sync access handle with backoff: contention (another tab mid-flush) is expected and
// transient. Returns null after the tries are exhausted — the caller keeps its lines queued and retries.
async function acquire(fh: any, tries = 5): Promise<any | null> {
  for (let a = 0; ; a++) {
    try { return await fh.createSyncAccessHandle(); }
    catch (e) {
      if (a >= tries - 1) return null;
      await sleep(Math.min(800, 40 * 2 ** a) + Math.random() * 40);
    }
  }
}

// Write the whole buffer at `at`, looping on the RETURNED count (the spec allows partial writes).
const writeAll = (h: any, buf: Uint8Array, at: number): void => {
  let off = 0;
  while (off < buf.byteLength) {
    const n = h.write(buf.subarray(off), { at: at + off });
    if (!n) throw new Error("opfs: write returned 0 bytes");
    off += n;
  }
};
// Read exactly `len` bytes at `at`, looping on the returned count.
const readAll = (h: any, len: number, at: number): Uint8Array => {
  const buf = new Uint8Array(len);
  let off = 0;
  while (off < len) {
    const n = h.read(buf.subarray(off), { at: at + off });
    if (!n) break; // EOF short of len: return what exists
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
};

// The worker-side persist: per-flush exclusive access, queued appends, transient contention.
function syncPersist(fh: any, name: string, initial: string): StorePersist {
  let pending: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let failStreak = 0;
  const flush = () => {
    chain = chain.then(async () => {
      if (!pending.length) return;
      const h = await acquire(fh);
      if (!h) {
        // contended: KEEP the lines queued, say so once per streak, retry on a timer — never demote
        modes.set(name, "contended");
        if (failStreak++ === 0) console.info(`eidoscope: cache file "${name}" is locked by another tab — writes queued, retrying`);
        setTimeout(flush, 500 + Math.random() * 500);
        return;
      }
      const lines = pending; pending = [];
      try {
        let at: number = h.getSize();
        // seal any torn tail (a terminate mid-write, or another tab's crash): if the file doesn't end
        // on a newline, write one first — the fragment becomes ONE malformed line the loader reports.
        if (at > 0) {
          const last = readAll(h, 1, at - 1);
          if (last.byteLength === 1 && last[0] !== NL) { writeAll(h, new Uint8Array([NL]), at); at += 1; }
        }
        const buf = new TextEncoder().encode(lines.join(""));
        writeAll(h, buf, at);
        h.flush();
        modes.set(name, "opfs"); failStreak = 0;
      } catch (e) {
        // an actual I/O failure (quota, detached FS): the lines go BACK on the queue and the next
        // append retries — reported, never silently swallowed into permanent memory-mode
        pending = lines.concat(pending);
        modes.set(name, "contended");
        if (failStreak++ === 0) console.warn(`eidoscope: cache write to "${name}" failed — queued, will retry on the next append`);
      } finally { try { h.close(); } catch {} }
    }).catch(() => {});
  };
  // drain: flush until the queue is empty or contention outlasts a bounded wait (~3s) — a caller about
  // to be terminated gets every line it can honestly get onto disk without hanging forever on a lock
  drainable.set(name, async () => {
    for (let g = 0; g < 6 && pending.length; g++) { flush(); await chain; if (pending.length) await sleep(500); }
    await chain;
  });
  return {
    read: () => initial || undefined,
    append: (line) => { pending.push(line); flush(); },
  };
}

// Await all in-flight cache flushes — the worker calls this before posting a result, so terminating
// the (now idle) worker after "done" cannot cut the tail off a cache file. Contended queues drain as
// far as their current chain; still-queued contended lines are re-attempted by their retry timer, and
// drain loops while progress is being made.
const drainable = new Map<string, () => Promise<void>>();
export async function opfsDrain(): Promise<void> {
  await Promise.all([...drainable.values()].map((d) => d().catch(() => {})));
}

async function opfsPersist(name: string): Promise<StorePersist | null> {
  try {
    const nav: any = (globalThis as any).navigator;
    if (!nav?.storage?.getDirectory) return null;
    const root = await nav.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const fh: any = await dir.getFileHandle(name, { create: true });
    // initial read via getFile(): needs NO lock, so a second tab can always LOAD the shared cache even
    // while the first is writing. Anything after the last newline is a torn tail — withheld here
    // (the writer seals it on the next flush; the loader then reports it as one malformed line).
    const file: File = await fh.getFile();
    let initial = await file.text();
    if (initial && !initial.endsWith("\n")) initial = initial.slice(0, initial.lastIndexOf("\n") + 1);
    const inWorker = typeof (globalThis as any).WorkerGlobalScope !== "undefined" && globalThis instanceof (globalThis as any).WorkerGlobalScope;
    if (inWorker && typeof fh.createSyncAccessHandle === "function") {
      const p = syncPersist(fh, name, initial);
      modes.set(name, "opfs");
      return p;
    }
    if (typeof fh.createWritable !== "function") return null;   // Safari < 18.2 outside a worker
    // main-thread fallback: createWritable commits only on close() (temp-file swap). Failures keep the
    // lines queued for the next append instead of latching a permanent memory-mode.
    let size = file.size;
    let pending: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const flush = () => {
      chain = chain.then(async () => {
        if (!pending.length) return;
        const lines = pending; pending = [];
        try {
          const buf = new TextEncoder().encode(lines.join(""));
          const w = await fh.createWritable({ keepExistingData: true });
          await w.seek(size);
          await w.write(buf);
          await w.close();                                      // commit point (temp-file swap)
          size += buf.byteLength;
          modes.set(name, "opfs");
        } catch {
          pending = lines.concat(pending);                      // back on the queue — the next append retries
          modes.set(name, "contended");
          console.warn(`eidoscope: cache write to "${name}" failed — queued, will retry on the next append`);
        }
      }).catch(() => {});
    };
    modes.set(name, "opfs");
    drainable.set(name, () => chain);
    return {
      read: () => initial || undefined,
      append: (line) => { pending.push(line); flush(); },
    };
  } catch { return null; }
}

// A Store persisted in OPFS when the browser can, session-memory (with one honest line) when it can't.
// ONE Store per filename per scope (memoized): ingest and descend share the regions cache instance so
// their appends serialize through one queue.
const stores = new Map<string, Promise<Store>>();
export function opfsStore(name: string): Promise<Store> {
  let p = stores.get(name);
  if (!p) {
    p = opfsPersist(name).then((persist) => {
      if (!persist) { warnOnce(); modes.set(name, "memory"); }
      return new Store(persist ?? undefined);
    });
    stores.set(name, p);
  }
  return p;
}

// Filenames carry the model id the way node's EmbeddingCache does (one file per embedder).
export const cacheFileName = (base: string, model?: string) =>
  model ? `${base}-${model.replace(/[^a-zA-Z0-9._-]+/g, "_")}.jsonl` : `${base}.jsonl`;
