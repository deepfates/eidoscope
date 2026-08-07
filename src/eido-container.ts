// The ONE codec for the `.eido` binary container — pure, node-free (only Web APIs: DataView / TypedArray /
// TextDecoder), so BOTH the Bun pipeline (src/mapbin.ts) and the browser viewer (viewer/src/loader.ts) import
// the same decode. Host-specific gzip is the only thing that stays per-host (node:zlib vs DecompressionStream);
// that's a real boundary, not duplication. Previously this parse (and the f16 math) was hand-copied in two files.
//
// container (before gzip): "EIDOBIN1" | u32 metaLen | metaJSON(utf8, 4-byte padded) | buffers(concat, 4-byte aligned)
import type { MapContract } from "./schema.ts";

export const MAGIC = "EIDOBIN1";
// v2: `type` gains "f16" (half-precision, for carried embedding vectors — measured lossless for cosine ranking
// at half the bytes). Width derives from type, so old readers that assumed 4 bytes stay correct for f32/i32.
export type BufType = "f32" | "i32" | "f16";
export type BufSpec = { key: string; type: BufType; length: number; offset: number };
export const WIDTH: Record<BufType, number> = { f32: 4, i32: 4, f16: 2 };

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
export const fromF16Buf = (a: Uint16Array): Float32Array => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f16ToF32(a[i]); return o; };

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
  const getOpt = (key: string): Float32Array | Int32Array | Uint16Array | undefined => {
    const s: BufSpec | undefined = meta.buffers.find((b: BufSpec) => b.key === key);
    if (!s) return undefined;
    const start = buf.byteOffset + base + s.offset, ab = buf.buffer.slice(start, start + s.length * (WIDTH[s.type] ?? 4));
    return s.type === "f32" ? new Float32Array(ab) : s.type === "f16" ? new Uint16Array(ab) : new Int32Array(ab);
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
  const vectors = meta.hasVectors ? unflat(fromF16Buf(getOpt("vectors") as Uint16Array), meta.vdim) : undefined;

  return {
    version: meta.version, provenance: meta.provenance, derivedBy: meta.derivedBy, metaFields: meta.metaFields, ids: meta.ids, titles: meta.titles, cores: meta.cores, notes: meta.notes,
    axes: meta.axes, scores, rawScores, xy: unflat(get("xy"), 2), xyz: unflat(get("xyz"), 3),
    cluster: Array.from(get("cluster")), k: meta.k, di: meta.di, levels, counts: meta.counts,
    levelLabels: meta.levelLabels, levelBlurbs: meta.levelBlurbs, clusters: meta.clusters,
    hub: Array.from(get("hub")), nbr, cite, citec: meta.citec, vectors,
    urls: sparse(meta.urls), sources: sparse(meta.sources), siteNames: sparse(meta.siteNames), authors: sparse(meta.authors), tags: sparse(meta.tags), dates: sparse(meta.dates), read: sparse(meta.read), ghosts: meta.ghosts, folders: sparse(meta.folders),
  };
}
