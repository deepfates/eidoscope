// ID-SET CODEC — how a frozen set of cards rides in a URL (eid-0iql).
//
// A selection (and a derived axis's examples) is a set of card ids. Spelling the ids out
// (`sel=<26-char-ulid>,<ulid>,…`) made a 141-card view a ~7KB link. The set is really a subset of the
// corpus's index space, so we serialize it as SORTED INDICES, delta-encoded, LEB128-varint-packed,
// base64url'd — ~2 chars per card instead of ~27. Indices alone would silently select the WRONG cards on a
// regenerated corpus of the same length, so the payload carries a 32-bit FNV-1a checksum of the ids the
// indices named at encode time: on decode against a corpus whose ids don't hash the same, the whole set is
// dropped (honest: no set is better than a lie about which set). Legacy comma-joined-ids params still
// resolve (missing ids drop out individually, as before).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INV: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

function toB64url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}
function fromB64url(s: string): number[] | null {
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of s) {
    const v = B64_INV[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  return bytes;
}

// FNV-1a 32-bit over a string — the classic tiny non-crypto hash; enough to catch "same length,
// different corpus" with 2^-32 odds, which is all this guard is for.
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const pushVarint = (bytes: number[], v: number) => { while (v > 127) { bytes.push((v & 127) | 128); v >>>= 7; } bytes.push(v); };

// indices → payload string. `sum` is fnv1a over the ids the indices name (joined with ","), computed by
// the caller who has the corpus. Dedupes and sorts — a set has no order or multiplicity.
export function encodeIdxSet(idx: number[], sum: number): string {
  const sorted = [...new Set(idx)].sort((a, b) => a - b);
  const bytes: number[] = [sum & 255, (sum >>> 8) & 255, (sum >>> 16) & 255, (sum >>> 24) & 255];
  let prev = -1;
  for (const v of sorted) { pushVarint(bytes, v - prev - 1); prev = v; }
  return toB64url(bytes);
}

export function decodeIdxSet(s: string): { idx: number[]; sum: number } | null {
  const bytes = fromB64url(s);
  if (!bytes || bytes.length < 4) return null;
  const sum = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const idx: number[] = [];
  let prev = -1, i = 4;
  while (i < bytes.length) {
    let v = 0, shift = 0, b: number;
    do { b = bytes[i++]; if (b === undefined) return null; v |= (b & 127) << shift; shift += 7; } while (b & 128);
    prev = prev + 1 + v; idx.push(prev);
  }
  return { idx, sum };
}

// One decoded URL id-set, either form: legacy explicit ids, or encoded indices + checksum.
export type UrlIdSet = { ids?: string[]; idx?: number[]; sum?: number };

// Parse a URL id-set payload. `*<b64>` = encoded; anything else = legacy comma-joined ids.
export function parseIdSet(payload: string): UrlIdSet | null {
  if (payload.startsWith("*")) { const d = decodeIdxSet(payload.slice(1)); return d ? { idx: d.idx, sum: d.sum } : null; }
  const ids = payload.split(",").filter(Boolean);
  return ids.length ? { ids } : null;
}

// Resolve a decoded set against THIS corpus's ids → indices, or null when it can't be honored.
// Legacy ids: unresolvable ids drop out individually (the corpus changed under the link; keep what's real).
// Encoded indices: out-of-range or checksum-mismatched drops the WHOLE set — the indices would name
// different cards than the sharer circled, and a plausible-looking wrong set is worse than none.
export function resolveIdSet(set: UrlIdSet, corpusIds: string[]): number[] | null {
  if (set.ids) { const out = set.ids.map((id) => corpusIds.indexOf(id)).filter((i) => i >= 0); return out.length ? out : null; }
  if (!set.idx?.length) return null;
  if (set.idx.some((i) => i < 0 || i >= corpusIds.length)) return null;
  if (fnv1a(set.idx.map((i) => corpusIds[i]).join(",")) !== (set.sum ?? -1)) return null;
  return set.idx;
}
