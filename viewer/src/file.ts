// The document's FILE SEAM (eid-cawh) — everything about where the open .eido came from and how bytes
// get back to disk lives here, so App speaks two verbs: openEido() and writeEido(). Per-browser truth
// (measured 2026-08-09, stated in docs/ARCHITECTURE.md "The loops → Save"):
//   Chromium — File System Access: showOpenFilePicker grants a FileSystemFileHandle; Save writes IN
//              PLACE via createWritable. Handles are structured-cloneable, so recents persist in
//              IndexedDB (idb-keyval) and reopen after a permission re-grant.
//   Safari/Firefox — no write-in-place: open is a plain <input type=file> / drop; Save is a download
//              that PRESERVES the original filename (never a numbered "-copy" of our making).
import { get, set } from "idb-keyval";

export type RecentFile = { name: string; opened: number; handle?: FileSystemFileHandle };

const RECENTS_KEY = "eido-recents";
const RECENTS_MAX = 8;

// ── the current document's source ──────────────────────────────────────────────────────────────────
let handle: FileSystemFileHandle | null = null;
let fileName = "map.eido";

export const currentFileName = () => fileName;
export const canWriteInPlace = () => handle !== null;
export const supportsFSA = () => typeof (globalThis as any).showOpenFilePicker === "function";

// Record where the open document came from. Drop/fetch paths call this with no handle (download-save);
// the picker and a Chromium drop (getAsFileSystemHandle) pass one (in-place save + a durable recent).
export function setSource(name: string, h: FileSystemFileHandle | null = null) {
  fileName = /\.eido$/i.test(name) ? name : name + ".eido";
  handle = h;
  if (h) void pushRecent({ name: fileName, opened: Date.now(), handle: h });
}

// ── recents (IndexedDB — handles survive reloads; permission is re-requested on reopen) ────────────
export async function listRecents(): Promise<RecentFile[]> {
  try { return ((await get(RECENTS_KEY)) as RecentFile[] | undefined) ?? []; } catch { return []; }
}
async function pushRecent(r: RecentFile) {
  try {
    const cur = await listRecents();
    const rest: RecentFile[] = [];
    for (const c of cur) {
      if (c.name === r.name && r.handle && c.handle && (await r.handle.isSameEntry(c.handle))) continue;
      if (c.name === r.name && !c.handle) continue;
      rest.push(c);
    }
    await set(RECENTS_KEY, [r, ...rest].slice(0, RECENTS_MAX));
  } catch {}   // recents are a convenience — storage failure must never block an open
}

// Reopen a recent: re-request permission on its stored handle (the graceful re-grant), read the file.
// Returns null when the user declines or the file is gone — the caller states it, nothing crashes.
export async function openRecent(r: RecentFile): Promise<File | null> {
  const h = r.handle; if (!h) return null;
  try {
    let perm = await (h as any).queryPermission?.({ mode: "read" });
    if (perm !== "granted") perm = await (h as any).requestPermission?.({ mode: "read" });
    if (perm !== "granted") return null;
    const f = await h.getFile();
    setSource(f.name, h);
    return f;
  } catch { return null; }
}

// ── OPEN — the picker where it exists; the caller falls back to its <input type=file> elsewhere ────
export async function openViaPicker(): Promise<File | null> {
  if (!supportsFSA()) return null;
  try {
    const [h] = await (globalThis as any).showOpenFilePicker({
      types: [{ description: "eidoscope map", accept: { "application/octet-stream": [".eido"] } }],
      excludeAcceptAllOption: false, multiple: false,
    });
    const f: File = await h.getFile();
    setSource(f.name, h);
    return f;
  } catch { return null; }   // user cancelled the picker — not an error
}

// ── SAVE — one verb, honest per-browser behavior ───────────────────────────────────────────────────
// With a held handle: write in place (permission re-requested if the grant lapsed). Without one:
// download under the ORIGINAL filename. Falls back from a failed in-place write (revoked permission,
// file moved) to the download rather than losing the save. Returns how the save actually happened.
export async function writeEido(bytes: Uint8Array): Promise<"wrote" | "downloaded"> {
  if (handle) {
    try {
      let perm = await (handle as any).queryPermission?.({ mode: "readwrite" });
      if (perm !== "granted") perm = await (handle as any).requestPermission?.({ mode: "readwrite" });
      if (perm === "granted") {
        const w = await handle.createWritable();
        await w.write(bytes as unknown as BufferSource);
        await w.close();
        return "wrote";
      }
    } catch {}   // fall through to the download — the save must not silently vanish
  }
  download(bytes, fileName, "application/octet-stream");
  return "downloaded";
}

// the ONE download helper — every export artifact leaves through here
export function download(data: Uint8Array | string, name: string, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
