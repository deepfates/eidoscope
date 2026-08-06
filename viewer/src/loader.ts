import type { MapContract } from "../../src/schema";
import { decodeContainer } from "../../src/eido-container";
export { decodeContainer };   // the ONE shared container parser (was hand-copied here — now src/eido-container.ts)

// Browser side of the wire format (src/mapbin.ts). Same container, but gzip via the native
// DecompressionStream (no library) and typed-array views over the decoded buffer. Two modes:
//  - EMBEDDED: the self-contained build inlines the base64 payload on window.__EIDO_DATA__ (portable file)
//  - FETCHED : a hosted app pulls ./map.eido (or any url) — the same decoder either way.

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
