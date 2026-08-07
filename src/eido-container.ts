// The ONE codec for the `.eido` binary container — pure, node-free (Web APIs plus fflate, which runs the same
// on both hosts), so BOTH the Bun pipeline (src/mapbin.ts) and the browser viewer (viewer/src/loader.ts) import
// the same decode. Host-specific gzip of the OUTER container is the only thing that stays per-host (node:zlib
// vs DecompressionStream); that's a real boundary, not duplication.
//
// container (before gzip): "EIDOBIN1" | u32 metaLen | metaJSON(utf8, 4-byte padded) | buffers(concat, 4-byte aligned)
import { gunzipSync } from "fflate";   // sync inflate for the lazy notes blocks — same pure-JS lib on both hosts
import type { MapContract } from "./schema.ts";

export const MAGIC = "EIDOBIN1";
// v2: `type` gains "f16" (half-precision, for carried embedding vectors — measured lossless for cosine ranking
// at half the bytes). Width derives from type, so old readers that assumed 4 bytes stay correct for f32/i32.
// v2.1: `type` gains "u8" (raw bytes — used for the ragged utf8 notes buffer, decoded lazily per card).
export type BufType = "f32" | "i32" | "f16" | "u8";
export type BufSpec = { key: string; type: BufType; length: number; offset: number };
export const WIDTH: Record<BufType, number> = { f32: 4, i32: 4, f16: 2, u8: 1 };

// f32<->f16 (IEEE half) — no Float16Array we can rely on on either side, so convert by hand.
// Round-to-nearest-even; handles subnormals/inf/nan.
export function f32ToF16(val: number): number {
  const f = new Float32Array(1), i = new Int32Array(f.buffer); f[0] = val; const x = i[0];
  const sign = (x >>> 16) & 0x8000; let exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);       // inf / nan
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;                             // overflow -> inf
  if (exp <= 0) {                                                    // subnormal / underflow
    if (exp < -10) return sign;
    mant |= 0x800000; const shift = 14 - exp; let h = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) h += 1; return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  if (mant & 0x1000) h += 1;                                         // round to nearest even
  return sign | h;
}
export function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16; const exp = (h >>> 10) & 0x1f, mant = h & 0x3ff; let bits: number;
  if (exp === 0) {
    if (mant === 0) bits = sign;
    else { let e = -1, m = mant; do { e++; m <<= 1; } while (!(m & 0x400)); bits = sign | ((127 - 15 - e) << 23) | ((m & 0x3ff) << 13); }
  } else if (exp === 0x1f) bits = sign | 0x7f800000 | (mant << 13);
  else bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  const i = new Int32Array(1), f = new Float32Array(i.buffer); i[0] = bits; return f[0];
}
export const toF16Buf = (a: Float32Array): Uint16Array => { const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f32ToF16(a[i]); return o; };
// Bulk decode goes through a one-time 65536-entry table: f16ToF32 allocates scratch arrays per call, which
// measured as the decode hot spot on a 5.3M-element vectors buffer (eid-cl83). 256KB once, then pure lookups.
let F16_LUT: Float32Array | null = null;
export const fromF16Buf = (a: Uint16Array): Float32Array => {
  if (!F16_LUT) { F16_LUT = new Float32Array(65536); for (let h = 0; h < 65536; h++) F16_LUT[h] = f16ToF32(h); }
  const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = F16_LUT[a[i]]; return o;
};

// The per-card notes ride as gzip BLOCKS of NOTES_BLOCK cards (see encodeMap): they are the biggest text
// section by far (31.8MB of 42.2MB meta on pathfinder), most of it never read in a session. This block size
// is an engineering constant, not ontology: ~2KB/card × 512 ≈ 1MB decompressed per block — big enough to
// compress well (~5×), small enough that first-touch inflate is ~ms. Readers use meta.notesBlock, never this.
export const NOTES_BLOCK = 512;

// Lazy view over the blocked notes: a real Array (so .length/iteration/Svelte's $state proxy all behave)
// whose rows are inflated-and-parsed on FIRST index read and cached in place. Opening one card inflates one
// block and parses one row; unread notes stay gzipped in memory.
function lazyNotes(z: Uint8Array | undefined, zi: Int32Array | undefined, offs: Int32Array | undefined, blockSize: number): Record<string, string>[] {
  if (!z || !zi || !offs) throw new Error("eidoscope: required buffer 'notes_z'/'notes_zi'/'notes_o' missing from .eido");
  const n = offs.length, cache: Record<string, string>[] = new Array(n), td = new TextDecoder();
  const blocks: (Uint8Array | undefined)[] = new Array(zi.length - 1);
  return new Proxy(cache, {
    get(t, p, r) {
      if (typeof p === "string") {
        const i = +p;
        if (Number.isInteger(i) && i >= 0 && i < n && t[i] === undefined) {
          const b = Math.floor(i / blockSize);
          const raw = (blocks[b] ??= gunzipSync(z.subarray(zi[b], zi[b + 1])));
          const end = (i + 1) % blockSize === 0 || i + 1 === n ? raw.length : offs[i + 1];
          t[i] = JSON.parse(td.decode(raw.subarray(offs[i], end)));
        }
      }
      return Reflect.get(t, p, r);
    },
  });
}

// Parse an UNCOMPRESSED container → MapContract. Callers gunzip first (host-specific) then hand the bytes here.
// width-aware + presence-tolerant: getOpt returns undefined for an absent buffer (a reader on a file that
// predates a section skips it, no crash); get() throws a CLEAR error naming a genuinely-missing required buffer.
export function decodeContainer(buf: Uint8Array): MapContract {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (magic !== MAGIC) throw new Error("eidoscope: not a .eido payload (bad magic: " + magic + ")");
  const metaLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + metaLen)));
  const metaPad = (4 - (metaLen % 4)) % 4;
  const base = 12 + metaLen + metaPad;
  const getOpt = (key: string): Float32Array | Int32Array | Uint16Array | Uint8Array | undefined => {
    const s: BufSpec | undefined = meta.buffers.find((b: BufSpec) => b.key === key);
    if (!s) return undefined;
    const start = buf.byteOffset + base + s.offset, ab = buf.buffer.slice(start, start + s.length * (WIDTH[s.type] ?? 4));
    return s.type === "f32" ? new Float32Array(ab) : s.type === "f16" ? new Uint16Array(ab) : s.type === "u8" ? new Uint8Array(ab) : new Int32Array(ab);
  };
  const get = (key: string): Float32Array | Int32Array => {
    const b = getOpt(key); if (!b) throw new Error(`eidoscope: required buffer '${key}' missing from .eido`);
    return b as Float32Array | Int32Array;
  };
  const n = meta.n;
  const unflat = (a: ArrayLike<number>, w: number) => Array.from({ length: n }, (_, i) => Array.from({ length: w }, (_, j) => a[i * w + j]));
  const unragged = (vals: ArrayLike<number>, offs: ArrayLike<number>) => Array.from({ length: offs.length - 1 }, (_, i) => Array.from({ length: offs[i + 1] - offs[i] }, (_, j) => vals[offs[i] + j]));
  // JSON turns undefined-in-array into null; the contract's optional metadata is (T | undefined)[], so restore that.
  const sparse = <T>(a: (T | null)[] | undefined) => (a ? a.map((x) => (x === null ? undefined : x)) : a);
  const scores: Record<string, number[]> = {};
  const sc = get("scores"); meta.axes.forEach((a: any, ai: number) => { scores[a.key] = Array.from({ length: n }, (_, i) => sc[ai * n + i]); });
  let rawScores: Record<string, number[]> | undefined;
  if (meta.buffers.some((b: any) => b.key === "rawScores")) { const rs = get("rawScores"); rawScores = {}; meta.axes.forEach((a: any, ai: number) => { rawScores![a.key] = Array.from({ length: n }, (_, i) => rs[ai * n + i]); }); }
  const nbr = unragged(get("nbr_v"), get("nbr_o"));
  const levels = meta.hasLevels ? unragged(get("levels_v"), get("levels_o")) : undefined;
  const cite = meta.hasCite ? unragged(get("cite_v"), get("cite_o")) : undefined;
  // vectors stay ONE flat Float32Array (n × vdim, row-major) — materializing n JS arrays was measured as
  // the largest decode-memory cost (~600MB of a ~1GB decode at 13,830 docs; eid-cl83).
  const vectors = meta.hasVectors ? { data: fromF16Buf(getOpt("vectors") as Uint16Array), dim: meta.vdim } : undefined;
  // notes: v2.1 files carry them as a ragged utf8 buffer, decoded LAZILY per card (a card's notes are only
  // parsed when that card is opened, cached after). Pre-v2.1 files still carry meta.notes — read as-is.
  const notes = meta.notes ?? lazyNotes(getOpt("notes_z") as Uint8Array, getOpt("notes_zi") as Int32Array, getOpt("notes_o") as Int32Array, meta.notesBlock);

  return {
    version: meta.version, provenance: meta.provenance, derivedBy: meta.derivedBy, metaFields: meta.metaFields, ids: meta.ids, titles: meta.titles, cores: meta.cores, notes,
    axes: meta.axes, scores, rawScores, xy: unflat(get("xy"), 2), xyz: unflat(get("xyz"), 3),
    cluster: Array.from(get("cluster")), k: meta.k, di: meta.di, levels, counts: meta.counts,
    levelLabels: meta.levelLabels, levelBlurbs: meta.levelBlurbs, clusters: meta.clusters,
    hub: Array.from(get("hub")), nbr, cite, citec: meta.citec, vectors,
    urls: sparse(meta.urls), sources: sparse(meta.sources), siteNames: sparse(meta.siteNames), authors: sparse(meta.authors), tags: sparse(meta.tags), dates: sparse(meta.dates), read: sparse(meta.read), ghosts: meta.ghosts, folders: sparse(meta.folders),
  };
}
