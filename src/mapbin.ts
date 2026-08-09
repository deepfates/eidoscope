import { gzipSync, gunzipSync } from "node:zlib";
import type { MapContract } from "./schema.ts";
import { encodeContainer, decodeContainer } from "./eido-container.ts";

// The wire format for the viewer data contract (schema.ts). The container codec itself is pure and
// host-free (src/eido-container.ts) — it must be, because the viewer's `view.save` re-emits the whole
// .eido in the browser (eid-thbs). This module is only the node-side gzip wrapper the pipeline and the
// round-trip tests use; the viewer wraps the same encodeContainer with fflate's gzip.
//
// container (before gzip):  "EIDOBIN1" | u32 metaLen | metaJSON(utf8, 4-byte padded) | buffers(concat, 4-byte aligned)
// metaJSON.buffers = [{key, type:'f32'|'i32'|'f16'|'u8', length, offset}]  — offsets are into the buffers region.

export function encodeMap(D: MapContract): Uint8Array {
  return gzipSync(encodeContainer(D));   // the ONE shared container encoder → node gzip
}

// Symmetric decoder (node) — the viewer mirrors this with DecompressionStream. Reconstructs the full
// MapContract so a round-trip test can prove nothing is lost.
export function decodeMap(gz: Uint8Array): MapContract {
  return decodeContainer(gunzipSync(gz));   // node gunzip → the ONE shared container parser (src/eido-container.ts)
}
