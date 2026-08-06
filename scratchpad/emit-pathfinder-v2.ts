// Regenerate the Pathfinder corpus (13830 cards, root map-data.json + deck.jsonl) as a v2 .eido with aligned
// card vectors + derivedBy + metaFields, so the viewer's new features (semantic query, metaField channels,
// 3D axis) actually appear for it. Run from repo root: bun run scratchpad/emit-pathfinder-v2.ts
import { readFileSync, writeFileSync } from "node:fs";
import { embedCards, buildMetaFields } from "../src/map.ts";
import { encodeMap } from "../src/mapbin.ts";

// embedCards reads a RELATIVE "cache-eidoscope-cards" — chdir to repo root where the pathfinder chunk cache lives.
process.chdir(new URL("..", import.meta.url).pathname);

const D: any = JSON.parse(readFileSync("map-data.json", "utf8"));
const cards: any[] = readFileSync("deck.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map(cards.map((c) => [c.id, c]));
const ordered = D.ids.map((id: string) => byId.get(id));
const missing = ordered.filter((c: any) => !c).length;
console.log(`pathfinder: ${D.ids.length} ids · ${cards.length} deck cards · ${missing} unmatched`);
if (missing) throw new Error(`${missing} ids have no card — alignment would be wrong`);

const vectors = await embedCards(ordered, D.axes);
console.log(`embedded ${vectors.length} cards × ${vectors[0].length} dims (aligned to D.ids order)`);

D.vectors = vectors;
D.derivedBy = { cardModel: "google/gemini-3-flash-preview", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim: vectors[0].length, pooling: "mean", normalized: true }, geometryBasis: "card", generated: 1754400000000 };
D.metaFields = buildMetaFields(D);
console.log(`metaFields: ${(D.metaFields || []).map((m: any) => m.key + ":" + m.type).join(", ")}`);

const enc = encodeMap(D);
writeFileSync("viewer/public/pathfinder.eido", enc);
writeFileSync("viewer/dist/pathfinder.eido", enc);
console.log(`wrote viewer/public+dist/pathfinder.eido — ${(enc.length / 1e6).toFixed(2)} MB (v2, with aligned vectors)`);
