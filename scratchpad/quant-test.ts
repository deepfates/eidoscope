// Does quantizing the CARRIED card vectors move the custom-semantic-axis ranking?
// Real card vectors (Pathfinder run) stored at f32 / f16 / int8; real queries embedded fresh (f32);
// project every card onto each query (dot product) -> ranking; measure how far quantized rankings drift
// from f32. Settles the format-v2 precision default empirically. Run: bun run scratchpad/quant-test.ts
import { readFileSync } from "node:fs";
import { getTextEmbeddings } from "../src/embed.ts";

const CACHE = "cache-eidoscope-cards/xenova_all_minilm_l6_v2.json";
const raw = JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, number[]>;
const ids = Object.keys(raw).slice(0, 3000);
const dim = raw[ids[0]].length;
const cards = ids.map((id) => Float32Array.from(raw[id]));
console.log(`loaded ${cards.length} real card vectors, dim=${dim}`);

// --- quantizers (round-trip: quantize then dequantize, as the viewer would read them back) ---
const f16 = (v: Float32Array) => { // truncate f32 mantissa 23->10 bits (f16 precision; unit vecs stay in f16 range)
  const out = new Float32Array(v.length), f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < v.length; i++) { f[0] = v[i]; u[0] = (u[0] + 0x1000) & ~0x1fff; out[i] = f[0]; }
  return out;
};
const int8 = (v: Float32Array) => { // per-vector symmetric max-abs scale
  let m = 0; for (const x of v) m = Math.max(m, Math.abs(x)); const s = m / 127 || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(v[i] / s) * s;
  return out;
};
const int8g = (all: Float32Array[]) => { // GLOBAL scale (one scale for the whole set)
  let m = 0; for (const v of all) for (const x of v) m = Math.max(m, Math.abs(x)); const s = m / 127 || 1;
  return all.map((v) => { const out = new Float32Array(v.length); for (let i = 0; i < v.length; i++) out[i] = Math.round(v[i] / s) * s; return out; });
};

const dot = (a: Float32Array | number[], b: Float32Array | number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rankOf = (scores: number[]) => { const idx = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]); const r = new Array(scores.length); idx.forEach((id, pos) => (r[id] = pos)); return { order: idx, rank: r }; };
const spearman = (r1: number[], r2: number[]) => { const n = r1.length; let d2 = 0; for (let i = 0; i < n; i++) { const d = r1[i] - r2[i]; d2 += d * d; } return 1 - (6 * d2) / (n * (n * n - 1)); };
const topK = (a: number[], b: number[], k: number) => { const A = new Set(a.slice(0, k)), B = new Set(b.slice(0, k)); let inter = 0; for (const x of A) if (B.has(x)) inter++; return inter / k; };

const QUERIES = ["healing magic and restoration", "undead monsters and necromancy", "swordplay and martial combat feats",
  "alchemical bombs and elixirs", "divine spells and deities", "stealth traps and hazards", "dragons and their breath weapons", "social skills and diplomacy"];
const qv = await getTextEmbeddings(QUERIES.map((t, i) => ({ id: "q" + i, text: t })));

const cardsF16 = cards.map(f16);
const cardsI8 = cards.map(int8);
const cardsI8g = int8g(cards);

const variants: [string, Float32Array[]][] = [["f16", cardsF16], ["int8(per-vec)", cardsI8], ["int8(global)", cardsI8g]];
const agg: Record<string, { rho: number; t10: number; t20: number; t100: number }> = {};
for (const [name] of variants) agg[name] = { rho: 0, t10: 0, t20: 0, t100: 0 };

for (let q = 0; q < QUERIES.length; q++) {
  const base = rankOf(cards.map((c) => dot(qv[q], c)));
  for (const [name, cv] of variants) {
    const r = rankOf(cv.map((c) => dot(qv[q], c)));
    agg[name].rho += spearman(base.rank, r.rank);
    agg[name].t10 += topK(base.order, r.order, 10);
    agg[name].t20 += topK(base.order, r.order, 20);
    agg[name].t100 += topK(base.order, r.order, 100);
  }
}
const N = QUERIES.length;
console.log(`\nquantization vs f32 ranking, averaged over ${N} real queries on ${cards.length} cards:`);
console.log("variant".padEnd(16), "Spearman", "top10", "top20", "top100");
for (const [name] of variants) {
  const a = agg[name];
  console.log(name.padEnd(16), (a.rho / N).toFixed(5).padStart(8), (a.t10 / N).toFixed(3).padStart(5), (a.t20 / N).toFixed(3).padStart(5), (a.t100 / N).toFixed(3).padStart(6));
}
// size deltas for the real corpora
console.log(`\nsize per 1000 cards @ dim ${dim}: f32=${((dim*4*1000)/1e6).toFixed(2)}MB  f16=${((dim*2*1000)/1e6).toFixed(2)}MB  int8=${((dim*1000+1000*4)/1e6).toFixed(2)}MB`);
for (const n of [1446, 13830]) console.log(`  ${n} cards: f32=${((dim*4*n)/1e6).toFixed(1)}MB  f16=${((dim*2*n)/1e6).toFixed(1)}MB  int8=${((dim*n)/1e6).toFixed(1)}MB`);
