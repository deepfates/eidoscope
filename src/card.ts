import { writeFileSync } from "node:fs";
import { deriveCard } from "./signatures.ts";
import { provider } from "./provider.ts";
import type { Axis } from "./axes.ts";
import type { Doc } from "./corpus.ts";

// The gorm layer applied at scale: one deriveCard per document -> the DECK.
// The deck is the asset. One card per JSONL line: inspectable, diffable, appendable.
export type Card = { id: string; title: string; cat?: string; date?: number; core: string; axes: Record<string, { score: number; note: string }> };

export const axesPrompt = (axes: Axis[]) =>
  axes.map((a, i) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

export async function cardCorpus(docs: Doc[], axes: Axis[], opts: { llm?: any; concurrency?: number; excerptChars?: number; onProgress?: (n: number) => void } = {}): Promise<Card[]> {
  const llm = opts.llm ?? provider();
  const conc = opts.concurrency ?? 12, cut = opts.excerptChars ?? 7000;
  const corpusAxes = axesPrompt(axes);
  const out: Card[] = [], q = [...docs];
  let done = 0;
  async function worker() {
    while (q.length) {
      const d = q.pop()!;
      try {
        const c: any = await deriveCard.forward(llm, { documentTitle: d.title, documentBody: d.body.slice(0, cut), corpusAxes });
        const ax: Record<string, { score: number; note: string }> = {};
        axes.forEach((a, i) => { ax[a.key] = { score: Number(c.axisScores?.[i] ?? 50), note: String(c.axisNotes?.[i] ?? "") }; });
        out.push({ id: d.id, title: d.title, cat: d.cat, date: d.date, core: String(c.coreSummary ?? ""), axes: ax });
      } catch { /* skip a failed card */ }
      opts.onProgress?.(++done);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

export const deckToJSONL = (cards: Card[]) => cards.map((c) => JSON.stringify(c)).join("\n") + "\n";

// verify: card a small sample against the fixture axes, check the deck shape
if (import.meta.main) {
  const { loadFixture, fixtureAxes } = await import("./corpus.ts");
  const { docs } = loadFixture();
  const axes = fixtureAxes();
  const sample = docs.filter((d) => d.body.length > 2000).slice(0, 15);
  console.error(`carding ${sample.length} sample docs over ${axes.length} axes...`);
  const deck = await cardCorpus(sample, axes, { concurrency: 8, onProgress: (n) => process.stderr.write(`  ${n}/${sample.length}\r`) });
  writeFileSync("deck-sample.jsonl", deckToJSONL(deck));
  const keys = axes.map((a: Axis) => a.key);
  const wellFormed = deck.filter((c) => c.core && keys.every((k: string) => typeof c.axes[k]?.score === "number" && c.axes[k]?.note !== undefined));
  console.log(`\n\ncarded ${deck.length}/${sample.length}; well-formed (core + all ${keys.length} axes): ${wellFormed.length}`);
  console.log("sample line:", JSON.stringify(deck[0]).slice(0, 160) + "…");
  console.log(wellFormed.length === deck.length && deck.length >= 12 ? "\n✅ card→deck stage works — JSONL deck, every card scored on every axis" : "\n⚠ malformed cards — inspect");
}
