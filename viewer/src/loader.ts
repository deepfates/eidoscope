import type { MapContract } from "../../src/schema";

// Browser side of the wire format (src/mapbin.ts). Same container, but gzip via the native
// DecompressionStream (no library) and typed-array views over the decoded buffer. Two modes:
//  - EMBEDDED: the self-contained build inlines the base64 payload on window.__EIDO_DATA__ (portable file)
//  - FETCHED : a hosted app pulls ./map.eido (or any url) — the same decoder either way.

const MAGIC = "EIDOBIN1";
// v2: `type` may be "f16" (carried vectors); width derives from type so old f32/i32 reads are unchanged.
type BufType = "f32" | "i32" | "f16";
type BufSpec = { key: string; type: BufType; length: number; offset: number };
const WIDTH: Record<BufType, number> = { f32: 4, i32: 4, f16: 2 };

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// IEEE half → float (mirror of src/mapbin.ts f16ToF32) so the browser can read the carried card vectors
// without a Float16Array. These are the re-interrogation substrate: custom semantic axes / search.
function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16; const exp = (h >>> 10) & 0x1f, mant = h & 0x3ff; let bits: number;
  if (exp === 0) { if (mant === 0) bits = sign; else { let e = -1, m = mant; do { e++; m <<= 1; } while (!(m & 0x400)); bits = sign | ((127 - 15 - e) << 23) | ((m & 0x3ff) << 13); } }
  else if (exp === 0x1f) bits = sign | 0x7f800000 | (mant << 13);
  else bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  const i = new Int32Array(1), f = new Float32Array(i.buffer); i[0] = bits; return f[0];
}

export function decodeContainer(buf: Uint8Array): MapContract {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (new TextDecoder().decode(buf.subarray(0, 8)) !== MAGIC) throw new Error("eidoscope: not a map.eido payload");
  const metaLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + metaLen)));
  const base = 12 + metaLen + ((4 - (metaLen % 4)) % 4);
  const get = (key: string): Float32Array | Int32Array => {
    const s: BufSpec | undefined = meta.buffers.find((b: BufSpec) => b.key === key);
    if (!s) throw new Error(`eidoscope: required buffer '${key}' missing from map payload`);
    const start = buf.byteOffset + base + s.offset, ab = buf.buffer.slice(start, start + s.length * (WIDTH[s.type] ?? 4));
    return s.type === "f32" ? new Float32Array(ab) : new Int32Array(ab); // f16 vectors are decoded separately below (semantic-query substrate)
  };
  const n: number = meta.n;
  const unflat = (a: ArrayLike<number>, w: number) => Array.from({ length: n }, (_, i) => Array.from({ length: w }, (_, j) => a[i * w + j]));
  const unragged = (v: ArrayLike<number>, o: ArrayLike<number>) => Array.from({ length: o.length - 1 }, (_, i) => Array.from({ length: o[i + 1] - o[i] }, (_, j) => v[o[i] + j]));
  const sparse = <T>(a: (T | null)[] | undefined) => (a ? a.map((x) => (x === null ? undefined : x)) : a);

  const scores: Record<string, number[]> = {};
  const sc = get("scores"); meta.axes.forEach((a: any, ai: number) => { scores[a.key] = Array.from({ length: n }, (_, i) => sc[ai * n + i]); });
  // OPTIONAL raw PCA projection per axis (honest-view substrate). Absent in older files → axes stay rank-only.
  let rawScores: Record<string, number[]> | undefined;
  if (meta.buffers.some((b: BufSpec) => b.key === "rawScores")) { const rs = get("rawScores"); rawScores = {}; meta.axes.forEach((a: any, ai: number) => { rawScores![a.key] = Array.from({ length: n }, (_, i) => rs[ai * n + i]); }); }

  // v2 carried card vectors (f16): the substrate for in-app semantic query / custom axes. Decoded to number[][].
  let vectors: number[][] | undefined;
  const vspec: BufSpec | undefined = meta.buffers.find((b: BufSpec) => b.key === "vectors");
  if (vspec && meta.vdim) {
    const start = buf.byteOffset + base + vspec.offset, u16 = new Uint16Array(buf.buffer.slice(start, start + vspec.length * 2));
    const flat = new Float32Array(u16.length); for (let i = 0; i < u16.length; i++) flat[i] = f16ToF32(u16[i]);
    vectors = unflat(flat, meta.vdim);
  }

  return {
    vectors,
    version: meta.version, provenance: meta.provenance, derivedBy: meta.derivedBy, metaFields: meta.metaFields, ids: meta.ids, titles: meta.titles, cores: meta.cores, notes: meta.notes,
    axes: meta.axes, scores, rawScores, xy: unflat(get("xy"), 2), xyz: unflat(get("xyz"), 3),
    cluster: Array.from(get("cluster")), k: meta.k, di: meta.di,
    levels: meta.hasLevels ? unragged(get("levels_v"), get("levels_o")) : undefined, counts: meta.counts,
    levelLabels: meta.levelLabels, levelBlurbs: meta.levelBlurbs, clusters: meta.clusters,
    hub: Array.from(get("hub")), nbr: unragged(get("nbr_v"), get("nbr_o")),
    cite: meta.hasCite ? unragged(get("cite_v"), get("cite_o")) : undefined, citec: meta.citec,
    urls: sparse(meta.urls), sources: sparse(meta.sources), siteNames: sparse(meta.siteNames), authors: sparse(meta.authors), tags: sparse(meta.tags), dates: sparse(meta.dates), read: sparse(meta.read), ghosts: meta.ghosts,
  };
}

// Which map to load: honor a `?map=<name>.eido` query so ONE built viewer can serve several corpora
// (Readwise, Pathfinder, …) from the same host. Restricted to a bare same-origin `.eido` filename —
// no scheme, no `//`, no path segments — so the param can't turn into a cross-origin or traversal fetch.
export function mapUrl(defaultUrl = "./map.eido"): string {
  try {
    const p = new URLSearchParams(location.search);
    const q = p.get("map");
    if (q && /^[A-Za-z0-9._-]+\.eido$/.test(q) && !q.includes("..")) return "./" + q;
    // ?url= opens a HOSTED .eido from anywhere ("open this map" links). The browser's CORS still bounds
    // reading a cross-origin response, and the provenance intro surfaces the corpus before it's trusted;
    // gate to http(s) so the param can't become a javascript:/data: vector.
    const u = p.get("url");
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}
  return defaultUrl;
}

// Load the map: embedded payload if present (self-contained build), else fetch the url (hosted/dev).
export async function loadMap(url = "./map.eido"): Promise<MapContract> {
  const embedded = (globalThis as any).__EIDO_DATA__;
  if (typeof embedded === "string") {
    const bin = Uint8Array.from(atob(embedded), (c) => c.charCodeAt(0));
    return decodeContainer(await gunzip(bin));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eidoscope: could not load ${url} (${res.status})`);
  return decodeContainer(await gunzip(new Uint8Array(await res.arrayBuffer())));
}

// Decode a .eido the user dropped in / opened locally (browser File → bytes). Same container, no network.
export async function decodeEido(bytes: Uint8Array): Promise<MapContract> {
  return decodeContainer(await gunzip(bytes));
}
