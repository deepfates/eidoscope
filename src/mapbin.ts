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
type BufSpec = { key: string; type: "f32" | "i32"; length: number; offset: number };

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
  const bufs: { key: string; arr: Float32Array | Int32Array }[] = [];
  bufs.push({ key: "xy", arr: flat(D.xy, 2) });
  bufs.push({ key: "xyz", arr: flat(D.xyz, 3) });
  bufs.push({ key: "hub", arr: Float32Array.from(D.hub) });
  bufs.push({ key: "cluster", arr: Int32Array.from(D.cluster) });
  // scores: axis-major flat (axis order = D.axes order)
  const sc = new Float32Array(D.axes.length * n);
  D.axes.forEach((a, ai) => { const col = D.scores[a.key] || []; for (let i = 0; i < n; i++) sc[ai * n + i] = col[i] ?? 50; });
  bufs.push({ key: "scores", arr: sc });
  // ragged / optional
  const nb = ragged(D.nbr); bufs.push({ key: "nbr_v", arr: nb.vals }, { key: "nbr_o", arr: nb.offs });
  if (D.levels) { const lv = ragged(D.levels); bufs.push({ key: "levels_v", arr: lv.vals }, { key: "levels_o", arr: lv.offs }); }
  if (D.cite) { const c = ragged(D.cite); bufs.push({ key: "cite_v", arr: c.vals }, { key: "cite_o", arr: c.offs }); }

  // lay buffers out 4-byte aligned; build the manifest
  const manifest: BufSpec[] = []; const chunks: Uint8Array[] = []; let offset = 0;
  for (const b of bufs) {
    const bytes = new Uint8Array(b.arr.buffer, b.arr.byteOffset, b.arr.byteLength);
    manifest.push({ key: b.key, type: b.arr instanceof Float32Array ? "f32" : "i32", length: b.arr.length, offset });
    chunks.push(bytes); offset += bytes.byteLength;
    const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
  }
  const bufferBlob = new Uint8Array(offset);
  { let o = 0; for (const c of chunks) { bufferBlob.set(c, o); o += c.byteLength; } }

  // meta = the contract MINUS what we moved to buffers (+ the manifest + axis key order)
  const meta = {
    version: CONTRACT_VERSION, n,
    ids: D.ids, titles: D.titles, cores: D.cores, notes: D.notes,
    axes: D.axes, k: D.k, di: D.di, counts: D.counts, levelLabels: D.levelLabels, levelBlurbs: D.levelBlurbs, clusters: D.clusters,
    urls: D.urls, authors: D.authors, tags: D.tags, dates: D.dates, read: D.read, citec: D.citec, ghosts: D.ghosts,
    hasLevels: !!D.levels, hasCite: !!D.cite,
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
  const get = (key: string): Float32Array | Int32Array => {
    const s = meta.buffers.find((b: BufSpec) => b.key === key)!;
    const ab = buf.buffer.slice(buf.byteOffset + base + s.offset, buf.byteOffset + base + s.offset + s.length * 4);
    return s.type === "f32" ? new Float32Array(ab) : new Int32Array(ab);
  };
  const n = meta.n;
  const unflat = (a: ArrayLike<number>, w: number) => Array.from({ length: n }, (_, i) => Array.from({ length: w }, (_, j) => a[i * w + j]));
  const unragged = (vals: ArrayLike<number>, offs: ArrayLike<number>) => Array.from({ length: offs.length - 1 }, (_, i) => Array.from({ length: offs[i + 1] - offs[i] }, (_, j) => vals[offs[i] + j]));

  const scores: Record<string, number[]> = {};
  const sc = get("scores"); meta.axes.forEach((a: any, ai: number) => { scores[a.key] = Array.from({ length: n }, (_, i) => sc[ai * n + i]); });
  const nbr = unragged(get("nbr_v"), get("nbr_o"));
  const levels = meta.hasLevels ? unragged(get("levels_v"), get("levels_o")) : undefined;
  const cite = meta.hasCite ? unragged(get("cite_v"), get("cite_o")) : undefined;

  return {
    version: meta.version, ids: meta.ids, titles: meta.titles, cores: meta.cores, notes: meta.notes,
    axes: meta.axes, scores, xy: unflat(get("xy"), 2), xyz: unflat(get("xyz"), 3),
    cluster: Array.from(get("cluster")), k: meta.k, di: meta.di, levels, counts: meta.counts,
    levelLabels: meta.levelLabels, levelBlurbs: meta.levelBlurbs, clusters: meta.clusters,
    hub: Array.from(get("hub")), nbr, cite, citec: meta.citec,
    urls: meta.urls, authors: meta.authors, tags: meta.tags, dates: meta.dates, read: meta.read, ghosts: meta.ghosts,
  };
}
