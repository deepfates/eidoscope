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

  // v2.2 (async-engine review round 3): NOTHING that grows with n rides in the meta JSON — its one
  // unchunkable JSON.parse must be bounded by content that does not grow with the corpus (axes, views,
  // provenance, per-LEVEL counts ~ O(log n)). Per-doc columns (ids/titles/cores + the optional
  // metadata) ride as ONE ragged utf8 buffer of per-row JSON (prow_*); per-region labels/blurbs, the
  // default-level region defs and the frontier ghosts as another (rrow_*). Both are chunk-parsed with
  // event-loop yields on decode — one bounded row at a time. Old files (these fields in meta) decode
  // through the legacy branch unchanged. Outer gzip compresses the utf8 rows exactly as it did the meta.
  const rowsBuf = (rows: string[]): { vals: Uint8Array; offs: Int32Array } => {
    const enc2 = new TextEncoder();
    const bs = rows.map((r) => enc2.encode(r));
    const offs = new Int32Array(bs.length + 1);
    for (let i = 0; i < bs.length; i++) offs[i + 1] = offs[i] + bs[i].byteLength;
    const vals = new Uint8Array(offs[bs.length]);
    for (let i = 0; i < bs.length; i++) vals.set(bs[i], offs[i]);
    return { vals, offs };
  };
  const cols = {
    urls: !!D.urls, sources: !!D.sources, siteNames: !!D.siteNames, authors: !!D.authors,
    tags: !!D.tags, dates: !!D.dates, read: !!D.read, folders: !!D.folders, citec: !!D.citec,
  };
  const pr = rowsBuf(D.ids.map((_, i) => JSON.stringify([
    D.ids[i], D.titles[i], D.cores[i],
    D.urls?.[i] ?? null, D.sources?.[i] ?? null, D.siteNames?.[i] ?? null, D.authors?.[i] ?? null,
    D.tags?.[i] ?? null, D.dates?.[i] ?? null, D.read?.[i] ?? null, D.folders?.[i] ?? null, D.citec?.[i] ?? null,
  ])));
  bufs.push({ key: "prow_v", arr: pr.vals, type: "u8" }, { key: "prow_o", arr: pr.offs, type: "i32" });
  const lls = D.levelLabels ?? [];
  const rrows: string[] = [];
  for (let l = 0; l < lls.length; l++) for (let r = 0; r < lls[l].length; r++) rrows.push(JSON.stringify([lls[l][r], D.levelBlurbs?.[l]?.[r] ?? null]));
  for (const c of D.clusters) rrows.push(JSON.stringify(c));
  for (const g of D.ghosts ?? []) rrows.push(JSON.stringify(g));
  const rr = rowsBuf(rrows);
  bufs.push({ key: "rrow_v", arr: rr.vals, type: "u8" }, { key: "rrow_o", arr: rr.offs, type: "i32" });

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

  // meta = the contract MINUS what we moved to buffers (+ the manifest + axis key order). Everything
  // here is bounded by axes/views/levels, never by n. `views` rides here: user-saved, small, additive.
  const meta = {
    version: CONTRACT_VERSION, n, provenance: D.provenance, derivedBy: D.derivedBy, metaFields: D.metaFields,
    axes: D.axes, k: D.k, di: D.di, xyzAgree: D.xyzAgree, counts: D.counts,
    cols, levelCounts: lls.map((a) => a.length), hasBlurbs: !!D.levelBlurbs, clustersN: D.clusters.length, ghostsN: (D.ghosts ?? []).length,
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
//
// ONE decode, two drains (review round 2, finding 3): the body is a GENERATOR that yields at chunk
// boundaries inside every heavy expansion loop. decodeContainer drains it synchronously (Bun pipeline,
// tests — identical behavior to before); decodeContainerAsync awaits a scheduler yield between chunks,
// so a browser main thread decoding a worker's result (or a dropped .eido) never runs one long task.
// Chunk sizes are engineering constants (like NOTES_BLOCK), sized so one chunk is ~a millisecond of
// work: 8192 rows of small-array building / 2^19 flat f16 conversions per slice.
const ROW_CHUNK = 8192, ELEM_CHUNK = 1 << 19;
function* decodeGen(buf: Uint8Array): Generator<void, MapContract> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (magic !== MAGIC) throw new Error("eidoscope: not a .eido payload (bad magic: " + magic + ")");
  const metaLen = dv.getUint32(8, true);
  // The one unchunkable step. Since v2.2 the meta JSON carries NOTHING that grows with n (per-doc and
  // per-region content ride as ragged utf8 buffers, chunk-parsed below), so this parse is bounded by
  // axes (~dozen) + views (user-saved) + per-LEVEL counts (~O(log n)) — measured ~8ms even on the OLD
  // layout with 13,796 docs' ids/titles/cores still inside (2026-08-09 probe); the v2.2 meta is ~KB.
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + metaLen)));
  yield;
  const metaPad = (4 - (metaLen % 4)) % 4;
  const base = 12 + metaLen + metaPad;
  // Materialize one buffer, COPY CHUNKED: buf.buffer.slice() of a whole column is itself an unbounded
  // main-thread pass (1M docs × 384 f16 dims = 732MiB in one memcpy). The allocation is one lazily
  // zero-paged step; the copy proceeds 8MiB per yield (~sub-ms each).
  function* getOptG(key: string): Generator<void, Float32Array | Int32Array | Uint16Array | Uint8Array | undefined> {
    const s: BufSpec | undefined = meta.buffers.find((b: BufSpec) => b.key === key);
    if (!s) return undefined;
    const bytes = s.length * (WIDTH[s.type] ?? 4);
    const src = new Uint8Array(buf.buffer, buf.byteOffset + base + s.offset, bytes);
    const out = new Uint8Array(bytes);
    const COPY_CHUNK = 1 << 23;
    for (let o = 0; o < bytes; o += COPY_CHUNK) { out.set(src.subarray(o, Math.min(bytes, o + COPY_CHUNK)), o); yield; }
    return s.type === "f32" ? new Float32Array(out.buffer) : s.type === "f16" ? new Uint16Array(out.buffer) : s.type === "u8" ? out : new Int32Array(out.buffer);
  }
  function* getG(key: string): Generator<void, Float32Array | Int32Array> {
    const b = yield* getOptG(key); if (!b) throw new Error(`eidoscope: required buffer '${key}' missing from .eido`);
    return b as Float32Array | Int32Array;
  }
  const n = meta.n;
  function* unflat(a: ArrayLike<number>, w: number): Generator<void, number[][]> {
    const out: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = new Array(w); for (let j = 0; j < w; j++) r[j] = a[i * w + j]; out[i] = r;
      if (i % ROW_CHUNK === ROW_CHUNK - 1) yield;
    }
    return out;
  }
  // yields on ELEMENTS, not rows — one pathological giant row can't run an unbounded inner loop
  function* unragged(vals: ArrayLike<number>, offs: ArrayLike<number>): Generator<void, number[][]> {
    const m = (offs as any).length - 1, out: number[][] = new Array(m);
    let c = 0;
    for (let i = 0; i < m; i++) {
      const len = offs[i + 1] - offs[i], r = new Array(len);
      for (let j = 0; j < len; j++) { r[j] = vals[offs[i] + j]; if (++c % ELEM_CHUNK === 0) yield; }
      out[i] = r;
    }
    return out;
  }
  function* col(a: ArrayLike<number>, ai: number): Generator<void, number[]> {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { out[i] = a[ai * n + i]; if (i % (ROW_CHUNK * 4) === ROW_CHUNK * 4 - 1) yield; }
    return out;
  }
  function* numArr(a: ArrayLike<number>): Generator<void, number[]> {
    const m = (a as any).length, out = new Array(m);
    for (let i = 0; i < m; i++) { out[i] = a[i]; if (i % (ROW_CHUNK * 4) === ROW_CHUNK * 4 - 1) yield; }
    return out;
  }
  const scores: Record<string, number[]> = {};
  const sc = yield* getG("scores");
  for (let ai = 0; ai < meta.axes.length; ai++) scores[meta.axes[ai].key] = yield* col(sc, ai);
  let rawScores: Record<string, number[]> | undefined;
  if (meta.buffers.some((b: any) => b.key === "rawScores")) {
    const rs = yield* getG("rawScores"); rawScores = {};
    for (let ai = 0; ai < meta.axes.length; ai++) rawScores[meta.axes[ai].key] = yield* col(rs, ai);
  }
  const nbr = yield* unragged(yield* getG("nbr_v"), yield* getG("nbr_o"));
  const levels = meta.hasLevels ? yield* unragged(yield* getG("levels_v"), yield* getG("levels_o")) : undefined;
  const cite = meta.hasCite ? yield* unragged(yield* getG("cite_v"), yield* getG("cite_o")) : undefined;
  // vectors stay ONE flat Float32Array (n × vdim, row-major) — materializing n JS arrays was measured as
  // the largest decode-memory cost (~600MB of a ~1GB decode at 13,830 docs; eid-cl83). The f16→f32
  // conversion (the measured decode hot spot) is chunked here rather than through fromF16Buf.
  let vectors: { data: Float32Array; dim: number } | undefined;
  if (meta.hasVectors) {
    const raw = (yield* getOptG("vectors")) as Uint16Array;
    if (!F16_LUT) { F16_LUT = new Float32Array(65536); for (let h = 0; h < 65536; h++) F16_LUT[h] = f16ToF32(h); }
    const data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) { data[i] = F16_LUT[raw[i]]; if (i % ELEM_CHUNK === ELEM_CHUNK - 1) yield; }
    vectors = { data, dim: meta.vdim };
  }
  // notes: v2.1 files carry them as a ragged utf8 buffer, decoded LAZILY per card (a card's notes are only
  // parsed when that card is opened, cached after). Pre-v2.1 files still carry meta.notes — read as-is.
  const notes = meta.notes ?? lazyNotes((yield* getOptG("notes_z")) as Uint8Array, (yield* getOptG("notes_zi")) as Int32Array, (yield* getOptG("notes_o")) as Int32Array, meta.notesBlock);

  const xy = yield* unflat(yield* getG("xy"), 2);
  const xyz = yield* unflat(yield* getG("xyz"), 3);
  const cluster = yield* numArr(yield* getG("cluster"));
  const hub = yield* numArr(yield* getG("hub"));

  // per-doc columns: v2.2 = prow rows (one bounded JSON.parse per doc, chunked); older files = meta
  // arrays, restored through the same chunked loops (sparse: JSON null → the contract's undefined).
  let ids: string[], titles: string[], cores: string[];
  let urls: any, sources: any, siteNames: any, authors: any, tags: any, dates: any, read: any, folders: any, citec: any;
  let levelLabels: string[][] | undefined = meta.levelLabels, levelBlurbs: string[][] | undefined = meta.levelBlurbs;
  let clusters: any = meta.clusters, ghosts: any = meta.ghosts;
  if (meta.buffers.some((b: any) => b.key === "prow_v")) {
    const pv = (yield* getOptG("prow_v")) as Uint8Array, po = (yield* getOptG("prow_o")) as Int32Array;
    const td = new TextDecoder(), c = meta.cols ?? {};
    ids = new Array(n); titles = new Array(n); cores = new Array(n);
    urls = c.urls ? new Array(n) : undefined; sources = c.sources ? new Array(n) : undefined;
    siteNames = c.siteNames ? new Array(n) : undefined; authors = c.authors ? new Array(n) : undefined;
    tags = c.tags ? new Array(n) : undefined; dates = c.dates ? new Array(n) : undefined;
    read = c.read ? new Array(n) : undefined; folders = c.folders ? new Array(n) : undefined;
    citec = c.citec ? new Array(n) : undefined;
    for (let i = 0; i < n; i++) {
      const row = JSON.parse(td.decode(pv.subarray(po[i], po[i + 1])));
      ids[i] = row[0]; titles[i] = row[1]; cores[i] = row[2];
      if (urls) urls[i] = row[3] ?? undefined; if (sources) sources[i] = row[4] ?? undefined;
      if (siteNames) siteNames[i] = row[5] ?? undefined; if (authors) authors[i] = row[6] ?? undefined;
      if (tags) tags[i] = row[7] ?? undefined; if (dates) dates[i] = row[8] ?? undefined;
      if (read) read[i] = row[9] ?? undefined; if (folders) folders[i] = row[10] ?? undefined;
      if (citec) citec[i] = row[11] ?? 0;
      if (i % 2048 === 2047) yield;
    }
    // per-region rows: level labels/blurbs, then the default-level RegionDefs, then ghosts — all
    // chunk-parsed (region count grows with n: finest grain ≈ n/GRAIN_MIN_REGION).
    const rv = (yield* getOptG("rrow_v")) as Uint8Array, ro = (yield* getOptG("rrow_o")) as Int32Array;
    let at = 0;
    const rrow = (i: number) => JSON.parse(td.decode(rv.subarray(ro[i], ro[i + 1])));
    const lcs: number[] = meta.levelCounts ?? [];
    levelLabels = lcs.length ? [] : undefined;
    levelBlurbs = meta.hasBlurbs ? [] : undefined;
    for (const lc of lcs) {
      const labs = new Array(lc), blurbs = meta.hasBlurbs ? new Array(lc) : undefined;
      for (let r = 0; r < lc; r++) { const row = rrow(at++); labs[r] = row[0]; if (blurbs) blurbs[r] = row[1] ?? undefined; if (at % 2048 === 0) yield; }
      levelLabels!.push(labs); if (blurbs) levelBlurbs!.push(blurbs);
    }
    clusters = new Array(meta.clustersN ?? 0);
    for (let r = 0; r < clusters.length; r++) { clusters[r] = rrow(at++); if (at % 2048 === 0) yield; }
    ghosts = meta.ghostsN ? new Array(meta.ghostsN) : undefined;
    if (ghosts) for (let r = 0; r < ghosts.length; r++) { ghosts[r] = rrow(at++); if (at % 2048 === 0) yield; }
  } else {
    // legacy (pre-v2.2): per-doc columns still in meta — restore undefined-for-null chunked
    function* sparseG<T>(a: (T | null)[] | undefined): Generator<void, (T | undefined)[] | undefined> {
      if (!a) return undefined;
      const out = new Array(a.length);
      for (let i = 0; i < a.length; i++) { out[i] = a[i] === null ? undefined : a[i]; if (i % (ROW_CHUNK * 4) === ROW_CHUNK * 4 - 1) yield; }
      return out;
    }
    ids = meta.ids; titles = meta.titles; cores = meta.cores; citec = meta.citec;
    urls = yield* sparseG(meta.urls); sources = yield* sparseG(meta.sources); siteNames = yield* sparseG(meta.siteNames);
    authors = yield* sparseG(meta.authors); tags = yield* sparseG(meta.tags); dates = yield* sparseG(meta.dates);
    read = yield* sparseG(meta.read); folders = yield* sparseG(meta.folders);
  }

  return {
    version: meta.version, provenance: meta.provenance, derivedBy: meta.derivedBy, metaFields: meta.metaFields, ids, titles, cores, notes,
    axes: meta.axes, scores, rawScores, xy, xyz, xyzAgree: meta.xyzAgree,
    cluster, k: meta.k, di: meta.di, levels, counts: meta.counts,
    levelLabels, levelBlurbs, clusters,
    hub, nbr, cite, citec, vectors,
    urls, sources, siteNames, authors, tags, dates, read, ghosts, folders,
    views: meta.views,
  };
}

// Synchronous drain — the Bun pipeline and tests, where blocking is fine and awaiting is noise.
export function decodeContainer(buf: Uint8Array): MapContract {
  const g = decodeGen(buf);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

// Cooperative drain for a browser MAIN thread: between chunks the decode yields to the event loop
// (scheduler.yield where the platform has it — continuation-priority, no 4ms setTimeout clamp — else
// setTimeout(0)), so frames keep painting while a large map materializes.
const yieldToLoop = (): Promise<void> =>
  typeof (globalThis as any).scheduler?.yield === "function" ? (globalThis as any).scheduler.yield() : new Promise((r) => setTimeout(r, 0));
export async function decodeContainerAsync(buf: Uint8Array): Promise<MapContract> {
  const g = decodeGen(buf);
  for (;;) { const r = g.next(); if (r.done) return r.value; await yieldToLoop(); }
}
