import { ax } from "@ax-llm/ax";
import { loadFixture, fixtureAxes } from "./corpus.ts";
import { cardCorpus, type Card } from "./card.ts";
import { embedCards } from "./map.ts";
import { neighborFaithfulness } from "./faithfulness.ts";

// THE SWING (cheap probe): does changing the card prompt move faithfulness at all?
// A = current signature. B = a variant that pushes for concrete specifics in the core.
// Same sample, same axes; card each under A and B, embed, measure neighbor-faithfulness.
// If B ≠ A meaningfully, prompt-tuning bites -> a full GEPA run is warranted. If not, we've
// learned (cheaply) that the cards are prompt-insensitive on this metric.
const deriveCardB = ax(`
  documentTitle:string, documentBody:string, corpusAxes:string ->
  coreSummary:string "2-3 sentences naming the SPECIFIC methods, systems, datasets, benchmarks, results and named entities in this document — concrete nouns over generic framing",
  axisScores:number[] "one 0-100 score per axis, in order; 0 = low pole, 100 = high pole",
  axisNotes:string[] "one short document-specific note per axis, in order"
`);

const N = Number(process.argv[2] || 140);
const { docs, embeddings } = loadFixture();
const axes = fixtureAxes();
const rows = docs.map((d, i) => ({ d, e: embeddings[i] })).filter((r) => r.d.body.length > 2500).slice(0, N);
const textById = new Map(rows.map((r) => [r.d.id, r.e]));
const sample = rows.map((r) => r.d);
console.error(`probe: ${sample.length} docs, ${axes.length} axes`);

async function faithOf(sig: any, label: string): Promise<number> {
  const deck: Card[] = await cardCorpus(sample, axes, { sig, concurrency: 12 });
  const embs = await embedCards(deck, axes);
  const byId = new Map(deck.map((c, i) => [c.id, embs[i]]));
  const common = deck.map((c) => c.id).filter((id) => textById.has(id));
  const T = common.map((id) => textById.get(id)!), C = common.map((id) => byId.get(id)!);
  const f = neighborFaithfulness(T, C, 10);
  console.error(`  ${label}: ${deck.length} cards, faithfulness ${(f * 100).toFixed(1)}% (n=${common.length})`);
  return f;
}

const fa = await faithOf(undefined, "A (current)");
const fb = await faithOf(deriveCardB, "B (specificity)");
const delta = (fb - fa) * 100;
console.log(`\nA current:      ${(fa * 100).toFixed(1)}%`);
console.log(`B specificity:  ${(fb * 100).toFixed(1)}%`);
console.log(`Δ = ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts`);
console.log(Math.abs(delta) >= 2
  ? `→ prompt-tuning MOVES faithfulness (${delta > 0 ? "B wins" : "A wins"}). A full GEPA run is worth it.`
  : `→ within noise (<2pts). The cards look prompt-insensitive on this metric — the concept-bottleneck is robust, tuning likely low-ROI. Banked either way.`);
