// Format-v2 round-trip + back-compat proof. Run: bun run scratchpad/roundtrip-test.ts
import { readFileSync } from "node:fs";
import { encodeMap, decodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails++; };

// synthetic map WITH vectors + derivedBy
const n = 40, dim = 16;
const rnd = (seed: number) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5; };
const r = rnd(7);
const vecs = Array.from({ length: n }, () => { const v = Array.from({ length: dim }, () => r()); const norm = Math.hypot(...v); return v.map((x) => x / norm); });
const D: MapContract = {
  version: 2, provenance: { title: "T", source: "s", generated: 1, count: n },
  derivedBy: { cardModel: "google/gemini-3-flash-preview", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim, pooling: "mean", normalized: true }, geometryBasis: "card", pipelineVersion: "test", generated: 123 },
  ids: Array.from({ length: n }, (_, i) => "d" + i), titles: Array.from({ length: n }, (_, i) => "Title " + i),
  cores: Array.from({ length: n }, (_, i) => "core " + i), notes: Array.from({ length: n }, () => ({ a: "note" })),
  axes: [{ key: "a", name: "A", low: "lo", high: "hi" }], scores: { a: Array.from({ length: n }, (_, i) => (i / n) * 100) },
  xy: Array.from({ length: n }, (_, i) => [Math.cos(i), Math.sin(i)]), xyz: Array.from({ length: n }, (_, i) => [Math.cos(i), Math.sin(i), i / n]),
  cluster: Array.from({ length: n }, (_, i) => i % 3), k: 3, di: 0, levels: [Array.from({ length: n }, (_, i) => i % 3)], counts: [3],
  clusters: [{ c: 0, n: 14, label: "R0" }, { c: 1, n: 13, label: "R1" }, { c: 2, n: 13, label: "R2" }],
  hub: Array.from({ length: n }, (_, i) => i % 5), nbr: Array.from({ length: n }, (_, i) => [(i + 1) % n, (i + 2) % n]),
  authors: Array.from({ length: n }, (_, i) => (i % 2 ? "Author" : undefined)), dates: Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i),
  vectors: vecs,
};

console.log("1) round-trip WITH vectors + derivedBy");
const back = decodeMap(encodeMap(D));
ok(back.version === 2, "version = 2");
ok(JSON.stringify(back.derivedBy) === JSON.stringify(D.derivedBy), "derivedBy preserved exactly");
ok(!!back.vectors && back.vectors.length === n && back.vectors[0].length === dim, `vectors shape ${back.vectors?.length}x${back.vectors?.[0]?.length}`);
// f16 fidelity: max abs error + cosine-ranking preserved against a query
let maxErr = 0; for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) maxErr = Math.max(maxErr, Math.abs(D.vectors![i][j] - back.vectors![i][j]));
ok(maxErr < 1e-3, `f16 max abs error ${maxErr.toExponential(2)} < 1e-3`);
const q = vecs[3]; const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const rankF32 = D.vectors!.map((_, i) => i).sort((a, b) => dot(q, D.vectors![b]) - dot(q, D.vectors![a]));
const rankF16 = back.vectors!.map((_, i) => i).sort((a, b) => dot(q, back.vectors![b]) - dot(q, back.vectors![a]));
ok(JSON.stringify(rankF32) === JSON.stringify(rankF16), "full query ranking identical after f16 round-trip");
// nbr are ints (i32, exact); xy/scores are f32 on the wire in v1 AND v2, so compare within f32 tolerance
const close = (a: number, b: number) => Math.abs(a - b) < 1e-5;
const xyOk = back.xy.every((row, i) => row.every((v, j) => close(v, D.xy[i][j])));
const scOk = back.scores.a.every((v, i) => close(v, D.scores.a[i]));
ok(JSON.stringify(back.nbr) === JSON.stringify(D.nbr) && xyOk && scOk, "existing fields intact (nbr exact; xy/scores within f32 tolerance — unchanged from v1)");

console.log("2) back-compat: emit a LITE map (no vectors/derivedBy) → no crash, absent optionals");
const { vectors, derivedBy, ...lite } = D;
const backLite = decodeMap(encodeMap(lite as MapContract));
ok(backLite.vectors === undefined, "lite: vectors undefined");
ok(backLite.derivedBy === undefined, "lite: derivedBy undefined");
ok(backLite.ids.length === n, "lite: rest intact");

console.log("3) forward-compat: decode REAL existing v1 .eido files (built before v2) → no crash");
for (const f of ["map.eido", "pathfinder.eido"]) {
  try {
    const d = decodeMap(readFileSync(f));
    ok(d.ids.length > 0 && d.vectors === undefined, `${f}: decoded ${d.ids.length} nodes, no vectors (v${d.version ?? 1}) — old file still loads`);
  } catch (e: any) { ok(false, `${f}: ${e.message}`); }
}

console.log(fails ? `\n✗ ${fails} failed` : "\n✅ all round-trip + compat checks passed");
process.exit(fails ? 1 : 0);
