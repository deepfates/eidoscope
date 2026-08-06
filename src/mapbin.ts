import { gzipSync, gunzipSync } from "node:zlib";
import { CONTRACT_VERSION, type MapContract } from "./schema.ts";

// The wire format for the viewer data contract (schema.ts). The big NUMERIC arrays — coordinates, the
// per-axis scores, hub, the grain levels, neighbor lists — become Float32/Int32 buffers (deck.gl reads
// typed arrays straight into GPU attributes, and floats-as-binary are a fraction of floats-as-JSON-text).
// Everything else (the strings: ids/titles/cores/notes, plus small structures) rides in a JSON header
// that gzip crushes. The whole container is gzipped. Decode side in the viewer uses native
// DecompressionStream (see viewer loader, eid-enqr); this module is the node/pipeline encoder + a
// symmetric decoder used by the round-trip test.
//
// container (before gzip):  "EIDOBIN1" | u32 metaLen | metaJSON(utf8, 4-byte padded) | buffers(concat, 4-byte aligned)
// metaJSON.buffers = [{key, type:'f32'|'i32', length, offset}]  — offsets are into the buffers region.

const MAGIC = "EIDOBIN1";
// v2: `type` gains "f16" (half-precision, for carried embedding vectors — measured lossless for cosine
// ranking at half the bytes). Width is derived from the type, so old readers that assumed 4 bytes stay
// correct for f32/i32 and new optional sections can be narrower. Presence is gated by `has*` meta flags
// (hasLevels/hasCite/hasVectors) — a reader skips a section it doesn't know, never crashes on its absence.
type BufType = "f32" | "i32" | "f16";
type BufSpec = { key: string; type: BufType; length: number; offset: number };
const WIDTH: Record<BufType, number> = { f32: 4, i32: 4, f16: 2 };

// f32<->f16 (IEEE half) — Node has no Float16Array until ES2025, and the browser can't rely on it either,
// so we convert by hand on both sides. Round-to-nearest-even; handles subnormals/inf/nan.
function f32ToF16(val: number): number {
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
function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16; const exp = (h >>> 10) & 0x1f, mant = h & 0x3ff; let bits: number;
  if (exp === 0) {
    if (mant === 0) bits = sign;
    else { let e = -1, m = mant; do { e++; m <<= 1; } while (!(m & 0x400)); bits = sign | ((127 - 15 - e) << 23) | ((m & 0x3ff) << 13); }
  } else if (exp === 0x1f) bits = sign | 0x7f800000 | (mant << 13);
  else bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  const i = new Int32Array(1), f = new Float32Array(i.buffer); i[0] = bits; return f[0];
}
const toF16Buf = (a: Float32Array): Uint16Array => { const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f32ToF16(a[i]); return o; };
const fromF16Buf = (a: Uint16Array): Float32Array => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = f16ToF32(a[i]); return o; };

const flat = (rows: number[][], w: number): Float32Array => {
  const out = new Float32Array(rows.length * w);
  for (let i = 0; i < rows.length; i++) { const r = rows[i] || []; for (let j = 0; j < w; j++) out[i * w + j] = r[j] ?? 0; }
  return out;
};
// ragged int rows -> flat values + (n+1) offsets, so nbr/cite/levels-of-varying-shape survive exactly.
const ragged = (rows: number[][]): { vals: Int32Array; offs: Int32Array } => {
  const offs = new Int32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) offs[i + 1] = offs[i] + (rows[i]?.length || 0);
  const vals = new Int32Array(offs[rows.length]);
  for (let i = 0, k = 0; i < rows.length; i++) for (const v of rows[i] || []) vals[k++] = v;
  return { vals, offs };
};

export function encodeMap(D: MapContract): Uint8Array {
  const n = D.ids.length;
  const bufs: { key: string; arr: Float32Array | Int32Array | Uint16Array; type: BufType }[] = [];
  bufs.push({ key: "xy", arr: flat(D.xy, 2), type: "f32" });
  bufs.push({ key: "xyz", arr: flat(D.xyz, 3), type: "f32" });
  bufs.push({ key: "hub", arr: Float32Array.from(D.hub), type: "f32" });
  bufs.push({ key: "cluster", arr: Int32Array.from(D.cluster), type: "i32" });
  // scores: axis-major flat (axis order = D.axes order)
  const sc = new Float32Array(D.axes.length * n);
  D.axes.forEach((a, ai) => { const col = D.scores[a.key] || []; for (let i = 0; i < n; i++) sc[ai * n + i] = col[i] ?? 50; });
  bufs.push({ key: "scores", arr: sc, type: "f32" });
  // OPTIONAL raw PCA projection per axis (axis-major, same layout as scores) — the honest-view substrate.
  if (D.rawScores && D.axes.every((a) => D.rawScores![a.key])) {
    const rs = new Float32Array(D.axes.length * n);
    D.axes.forEach((a, ai) => { const col = D.rawScores![a.key]; for (let i = 0; i < n; i++) rs[ai * n + i] = col[i] ?? 0; });
    bufs.push({ key: "rawScores", arr: rs, type: "f32" });
  }
  // ragged / optional
  const nb = ragged(D.nbr); bufs.push({ key: "nbr_v", arr: nb.vals, type: "i32" }, { key: "nbr_o", arr: nb.offs, type: "i32" });
  if (D.levels) { const lv = ragged(D.levels); bufs.push({ key: "levels_v", arr: lv.vals, type: "i32" }, { key: "levels_o", arr: lv.offs, type: "i32" }); }
  if (D.cite) { const c = ragged(D.cite); bufs.push({ key: "cite_v", arr: c.vals, type: "i32" }, { key: "cite_o", arr: c.offs, type: "i32" }); }
  // v2 OPTIONAL: per-node card embedding vectors (the re-interrogation substrate — custom semantic axes,
  // new-point placement). Stored f16 (measured lossless for cosine ranking). A "lite" emit omits D.vectors.
  const vdim = D.vectors?.[0]?.length ?? 0;
  if (D.vectors && vdim) bufs.push({ key: "vectors", arr: toF16Buf(flat(D.vectors, vdim)), type: "f16" });

  // lay buffers out 4-byte aligned; build the manifest
  const manifest: BufSpec[] = []; const chunks: Uint8Array[] = []; let offset = 0;
  for (const b of bufs) {
    const bytes = new Uint8Array(b.arr.buffer, b.arr.byteOffset, b.arr.byteLength);
    manifest.push({ key: b.key, type: b.type, length: b.arr.length, offset });
    chunks.push(bytes); offset += bytes.byteLength;
    const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
  }
  const bufferBlob = new Uint8Array(offset);
  { let o = 0; for (const c of chunks) { bufferBlob.set(c, o); o += c.byteLength; } }

  // meta = the contract MINUS what we moved to buffers (+ the manifest + axis key order)
  const meta = {
    version: CONTRACT_VERSION, n, provenance: D.provenance, derivedBy: D.derivedBy, metaFields: D.metaFields,
    ids: D.ids, titles: D.titles, cores: D.cores, notes: D.notes,
    axes: D.axes, k: D.k, di: D.di, counts: D.counts, levelLabels: D.levelLabels, levelBlurbs: D.levelBlurbs, clusters: D.clusters,
    urls: D.urls, sources: D.sources, siteNames: D.siteNames, authors: D.authors, tags: D.tags, dates: D.dates, read: D.read, citec: D.citec, ghosts: D.ghosts,
    hasLevels: !!D.levels, hasCite: !!D.cite, hasVectors: !!(D.vectors && vdim), vdim,
    buffers: manifest,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const metaPad = (4 - (metaBytes.byteLength % 4)) % 4;

  const head = new Uint8Array(8 + 4);
  new TextEncoder().encodeInto(MAGIC, head);
  new DataView(head.buffer).setUint32(8, metaBytes.byteLength, true);

  const container = new Uint8Array(head.byteLength + metaBytes.byteLength + metaPad + bufferBlob.byteLength);
  let p = 0; container.set(head, p); p += head.byteLength; container.set(metaBytes, p); p += metaBytes.byteLength + metaPad; container.set(bufferBlob, p);
  return gzipSync(container);
}

// Symmetric decoder (node) — the viewer mirrors this with DecompressionStream. Reconstructs the full
// MapContract so a round-trip test can prove nothing is lost.
export function decodeMap(gz: Uint8Array): MapContract {
  const buf = gunzipSync(gz);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (magic !== MAGIC) throw new Error("bad magic: " + magic);
  const metaLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + metaLen)));
  const metaPad = (4 - (metaLen % 4)) % 4;
  const base = 12 + metaLen + metaPad;
  // width-aware + presence-tolerant: getOpt returns undefined for an absent buffer (a reader on a file
  // that predates a section skips it, no crash); get() throws a CLEAR error naming a genuinely-missing
  // required buffer instead of a cryptic undefined dereference.
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

  // JSON turns undefined-in-array into null; the contract's optional metadata is (T | undefined)[], so
  // restore that exactly — null and undefined both mean "absent", but we honor the declared type.
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
    urls: sparse(meta.urls), sources: sparse(meta.sources), siteNames: sparse(meta.siteNames), authors: sparse(meta.authors), tags: sparse(meta.tags), dates: sparse(meta.dates), read: sparse(meta.read), ghosts: meta.ghosts,
  };
}
