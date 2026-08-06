// Step 0 + Step 1(Node): emit a CORRECT v2 .eido for the 1440-card Readwise corpus (each card's OWN
// aligned MiniLM vector), then PROVE the semantic-query keystone in Node — embed a typed query with the
// same model and cosine-rank the cards. Run from repo root: bun run scratchpad/readwise-run/emit-and-prove.ts
import { readFileSync, writeFileSync } from "node:fs";
import { embedCards, buildMetaFields } from "../../src/map.ts";
import { encodeMap } from "../../src/mapbin.ts";
import { getTextEmbeddings } from "../../src/embed.ts";

// embedCards reads a RELATIVE "cache-eidoscope-cards" — chdir into the readwise run so it hits THESE chunks.
process.chdir(new URL(".", import.meta.url).pathname);

const D: any = JSON.parse(readFileSync("map-data.json", "utf8"));
const cards: any[] = readFileSync("deck.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map(cards.map((c) => [c.id, c]));
const ordered = D.ids.map((id: string) => byId.get(id));
const missing = ordered.filter((c: any) => !c).length;
console.log(`corpus: ${D.ids.length} ids · ${cards.length} deck cards · ${missing} unmatched`);
if (missing) throw new Error(`${missing} ids have no card — alignment would be wrong`);

// each card's OWN vector, chunk-pooled exactly as the geometry was (cardText + poolEmbed against the cache)
const vectors = await embedCards(ordered, D.axes);
console.log(`embedded ${vectors.length} cards × ${vectors[0].length} dims (aligned to D.ids order)`);

D.vectors = vectors;
D.derivedBy = { cardModel: "google/gemini-3-flash-preview", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim: vectors[0].length, pooling: "mean", normalized: true }, geometryBasis: "card", generated: 1754400000000 };
D.metaFields = buildMetaFields(D);
console.log(`metaFields: ${(D.metaFields || []).map((m: any) => m.key + ":" + m.type).join(", ")}`);

const enc = encodeMap(D);
writeFileSync("../../viewer/public/map.eido", enc);   // source of truth (build copies public/ → dist/)
writeFileSync("../../viewer/dist/map.eido", enc);     // and the currently-served dist, so no rebuild needed
console.log(`wrote viewer/public+dist/map.eido — ${(enc.length / 1e6).toFixed(2)} MB (v2, with aligned vectors)`);

// ---- PROVE the keystone: typed query -> same MiniLM -> cosine-rank the cards ----
const cos = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
const rank = (q: number[], k = 8) => vectors.map((v, i) => [i, cos(q, v)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, k);

for (const query of ["reinforcement learning", "consciousness and subjective experience", "personal note-taking and knowledge management", "venture capital and startup funding"]) {
  const [qv] = await getTextEmbeddings([{ id: "__q__" + query, text: query }]);
  console.log(`\n▸ "${query}"`);
  for (const [i, s] of rank(qv)) console.log(`   ${s.toFixed(3)}  ${(D.titles[i] || "").slice(0, 64)}`);
}
