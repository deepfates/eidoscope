// The ONE codec for the `.eido` binary container — pure, node-free (Web APIs plus fflate, which runs the same
// on both hosts), so BOTH the Bun pipeline (src/mapbin.ts) and the browser viewer (viewer/src/loader.ts) import
// the same decode. Host-specific gzip of the OUTER container is the only thing that stays per-host (node:zlib
// vs DecompressionStream); that's a real boundary, not duplication.
//
// container (before gzip): "EIDOBIN1" | u32 metaLen | metaJSON(utf8, 4-byte padded) | buffers(concat, 4-byte aligned)
// ENCODE lives here too (eid-thbs): the viewer's `view.save` re-emits the whole .eido in the browser, so
// the encoder must be as host-free as the decoder — fflate gzip for the notes blocks on both hosts.
import { gunzipSync, gzipSync } from "fflate";   // sync (in|de)flate for the notes blocks — same pure-JS lib on both hosts
import { CONTRACT_VERSION, type MapContract } from "./schema.ts";

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
  const idxOf = (p: string | symbol) => { if (typeof p !== "string") return -1; const i = +p; return Number.isInteger(i) && i >= 0 && i < n ? i : -1; };
  const materialize = (i: number) => {
    if (cache[i] === undefined) {
      const b = Math.floor(i / blockSize);
      const raw = (blocks[b] ??= gunzipSync(z.subarray(zi[b], zi[b + 1])));
      const end = (i + 1) % blockSize === 0 || i + 1 === n ? raw.length : offs[i + 1];
      cache[i] = JSON.parse(td.decode(raw.subarray(offs[i], end)));
    }
    return cache[i];
  };
  // The cache is a SPARSE array, and reactive wrappers (Svelte's $state proxy) consult `has` and
  // property descriptors before reading — a get-only trap answers "not there" for unparsed holes and
  // the row silently reads as undefined. So `has` and getOwnPropertyDescriptor must vouch for (and
  // materialize) every in-range index, not just `get`.
  return new Proxy(cache, {
    has: (t, p) => idxOf(p) >= 0 || Reflect.has(t, p),
    getOwnPropertyDescriptor(t, p) {
      const i = idxOf(p);
      if (i >= 0) return { value: materialize(i), enumerable: true, configurable: true, writable: true };
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
    get(t, p, r) {
      const i = idxOf(p);
      if (i >= 0) return materialize(i);
      return Reflect.get(t, p, r);
    },
  });
}

// ── ENCODE: MapContract → UNCOMPRESSED container. Callers gzip the result (host-specific: node:zlib in
// the pipeline, fflate/CompressionStream in the viewer). Moved here from src/mapbin.ts (eid-thbs) so the
// browser can re-emit a .eido carrying newly saved views; mapbin keeps the node gzip wrapper.
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

export function encodeContainer(D: MapContract): Uint8Array {
  const n = D.ids.length;
  const bufs: { key: string; arr: Float32Array | Int32Array | Uint16Array | Uint8Array; type: BufType }[] = [];
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
  const vdim = D.vectors?.dim ?? 0;
  if (D.vectors && vdim) bufs.push({ key: "vectors", arr: toF16Buf(D.vectors.data), type: "f16" });
  // v2.1: the per-card axis notes move OUT of the JSON meta (they were its single largest section — measured
  // 31.8MB of a 42.2MB meta on pathfinder, and living there forced an eager JSON.parse of every note on load)
  // into gzip BLOCKS of NOTES_BLOCK cards: notes_z (concatenated gzipped blocks) + notes_zi (block byte
  // offsets) + notes_o (each row's offset inside its DECOMPRESSED block). The decoder inflates one block on
  // first touch and parses one row per card open — notes stay compressed in memory (~5x) until a card needs
  // them. Old files (notes still in meta) remain readable; see decodeContainer.
  {
    const enc = new TextEncoder();
    const rows = D.notes.map((r) => enc.encode(JSON.stringify(r ?? {})));
    const offs = new Int32Array(rows.length);                           // offset of row i WITHIN its block
    const blocks: Uint8Array[] = []; const zi = new Int32Array(Math.ceil(rows.length / NOTES_BLOCK) + 1);
    for (let b = 0; b * NOTES_BLOCK < rows.length; b++) {
      const slice = rows.slice(b * NOTES_BLOCK, (b + 1) * NOTES_BLOCK);
      let len = 0; for (let j = 0; j < slice.length; j++) { offs[b * NOTES_BLOCK + j] = len; len += slice[j].byteLength; }
      const raw = new Uint8Array(len); { let o = 0; for (const r of slice) { raw.set(r, o); o += r.byteLength; } }
      const z = gzipSync(raw); blocks.push(z); zi[b + 1] = zi[b] + z.byteLength;
    }
    const notes_z = new Uint8Array(zi[blocks.length]); { let o = 0; for (const z of blocks) { notes_z.set(z, o); o += z.byteLength; } }
    bufs.push({ key: "notes_z", arr: notes_z, type: "u8" }, { key: "notes_zi", arr: zi, type: "i32" }, { key: "notes_o", arr: offs, type: "i32" });
  }

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

  // meta = the contract MINUS what we moved to buffers (+ the manifest + axis key order).
  // `views` rides here: it is small relative to notes, and JSON keeps it trivially additive.
  const meta = {
    version: CONTRACT_VERSION, n, provenance: D.provenance, derivedBy: D.derivedBy, metaFields: D.metaFields,
    ids: D.ids, titles: D.titles, cores: D.cores,
    axes: D.axes, k: D.k, di: D.di, xyzAgree: D.xyzAgree, counts: D.counts, levelLabels: D.levelLabels, levelBlurbs: D.levelBlurbs, clusters: D.clusters,
    urls: D.urls, sources: D.sources, siteNames: D.siteNames, authors: D.authors, tags: D.tags, dates: D.dates, read: D.read, citec: D.citec, ghosts: D.ghosts, folders: D.folders,
    views: D.views,
    hasLevels: !!D.levels, hasCite: !!D.cite, hasVectors: !!(D.vectors && vdim), vdim, notesBlock: NOTES_BLOCK,
    buffers: manifest,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const metaPad = (4 - (metaBytes.byteLength % 4)) % 4;

  const head = new Uint8Array(8 + 4);
  new TextEncoder().encodeInto(MAGIC, head);
  new DataView(head.buffer).setUint32(8, metaBytes.byteLength, true);

  const container = new Uint8Array(head.byteLength + metaBytes.byteLength + metaPad + bufferBlob.byteLength);
  let p = 0; container.set(head, p); p += head.byteLength; container.set(metaBytes, p); p += metaBytes.byteLength + metaPad; container.set(bufferBlob, p);
  return container;
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
    axes: meta.axes, scores, rawScores, xy: unflat(get("xy"), 2), xyz: unflat(get("xyz"), 3), xyzAgree: meta.xyzAgree,
    cluster: Array.from(get("cluster")), k: meta.k, di: meta.di, levels, counts: meta.counts,
    levelLabels: meta.levelLabels, levelBlurbs: meta.levelBlurbs, clusters: meta.clusters,
    hub: Array.from(get("hub")), nbr, cite, citec: meta.citec, vectors,
    urls: sparse(meta.urls), sources: sparse(meta.sources), siteNames: sparse(meta.siteNames), authors: sparse(meta.authors), tags: sparse(meta.tags), dates: sparse(meta.dates), read: sparse(meta.read), ghosts: meta.ghosts, folders: sparse(meta.folders),
    views: meta.views,
  };
}
