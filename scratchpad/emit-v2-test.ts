// Real-corpus v2 emit: take the on-disk 13830-node map-data.json, attach the cached card vectors +
// derivedBy, encode, measure the true size delta vs the v1 file, and round-trip. Run: bun run scratchpad/emit-v2-test.ts
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { encodeMap, decodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";

const D = JSON.parse(readFileSync("map-data.json", "utf8")) as MapContract;
const cache = JSON.parse(readFileSync("cache-eidoscope-cards/xenova_all_minilm_l6_v2.json", "utf8")) as Record<string, number[]>;
const n = D.ids.length;
// cache is keyed by card text-hash, not doc id — so use its ACTUAL vectors (real, distinct) for an honest
// size measurement; exact node alignment is irrelevant to the gzipped byte count.
const vals = Object.values(cache);
const dim = vals[0].length;
const vectors = D.ids.map((_, i) => vals[i % vals.length]);
console.log(`map-data.json: ${n} nodes · using ${Math.min(n, vals.length)} distinct real card vectors (cache has ${vals.length}, dim ${dim})`);

D.vectors = vectors;
(D as any).derivedBy = { cardModel: "google/gemini-3-flash-preview", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim, pooling: "mean", normalized: true }, geometryBasis: "card", generated: Date.now() };

const v1 = statSync("map.eido").size;                       // existing v1 file on disk (no vectors)
const enc = encodeMap(D);
writeFileSync("scratchpad/map-v2.eido", enc);
console.log(`\nfile size (gzipped .eido):`);
console.log(`  v1 (no vectors):   ${(v1 / 1e6).toFixed(2)} MB`);
console.log(`  v2 (with vectors): ${(enc.length / 1e6).toFixed(2)} MB   (+${((enc.length - v1) / 1e6).toFixed(2)} MB for ${n}×${dim} f16 card vectors)`);

const back = decodeMap(enc);
const q = vectors[100];
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const rf = (vs: number[][]) => vs.map((_, i) => i).sort((a, b) => dot(q, vs[b]) - dot(q, vs[a])).slice(0, 20);
const top20match = JSON.stringify(rf(vectors)) === JSON.stringify(rf(back.vectors!));
console.log(`\nround-trip: version ${back.version}, vectors ${back.vectors?.length}×${back.vectors?.[0]?.length}, geometryBasis="${back.derivedBy?.geometryBasis}"`);
console.log(`  top-20 query ranking identical after f16 round-trip on the REAL corpus: ${top20match ? "✓" : "✗"}`);
