import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCard } from "./signatures.ts";
import { provider } from "./provider.ts";
import { hash, Store, pool, withRetry } from "./llm.ts";
import type { Axis } from "./axes.ts";
import type { Doc } from "./corpus.ts";

// The gorm layer applied at scale -> the DECK. One full-text deriveCard call per document, cached by
// document content + the DETERMINISTIC axis geometry (PC index + variance). PCA is deterministic, so the
// same corpus yields the same axes every run; the LLM only relabels them, and those names are cosmetic
// and never touch the key — so re-running the same corpus reloads every card instead of re-carding.
export type Card = { id: string; title: string; cat?: string; date?: number; url?: string; author?: string; tags?: string[]; path?: string; readProgress?: number; core: string; axes: Record<string, { note: string }> };

export const axesPrompt = (axes: Axis[]) =>
  axes.map((a, i) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

export async function cardCorpus(docs: Doc[], axes: Axis[], opts: { llm?: any; sig?: any; concurrency?: number; cache?: string } = {}): Promise<Card[]> {
  const llm = opts.llm ?? provider();
  const sig = opts.sig ?? deriveCard;
  const conc = opts.concurrency ?? 12;
  const corpusAxes = axesPrompt(axes);
  const cacheDir = typeof opts.cache === "string" ? opts.cache : undefined;
  const cache = new Store(cacheDir ? join(cacheDir, "card-cache.jsonl") : undefined);
  // key = document content + DETERMINISTIC axis geometry (PC index + variance). NOT the LLM labels.
  const geo = axes.map((a) => a.pc + ":" + (a.var ?? 0).toFixed(6)).join("|");
  const key = (d: Doc) => hash("card1 " + d.title + " " + d.body + " " + geo);

  const need = docs.filter((d) => !cache.has(key(d)));
  let done = 0, fail = 0;
  const tick = () => { if (need.length && (++done % 50 === 0 || done === need.length)) process.stderr.write(`  cards ${done}/${need.length}\r`); };
  await pool(need, async (d) => {
    const r: any = await withRetry(() => sig.forward(llm, { documentTitle: d.title, documentText: d.body, corpusAxes }));
    if (r?.restatement) cache.put(key(d), { core: String(r.restatement), placements: (r.axisPlacements ?? []).map(String) });
    else fail++;
    tick();
  }, conc);
  if (fail) console.error(`  ⚠ ${fail} cards failed after retries (reported, not silently dropped)`);

  const out: Card[] = [];
  for (const d of docs) {
    const c = cache.get(key(d)); if (!c) continue;
    const ax: Record<string, { note: string }> = {};
    axes.forEach((a, i) => { ax[a.key] = { note: String(c.placements?.[i] ?? "") }; });
    out.push({ id: d.id, title: d.title, cat: d.cat, date: d.date, url: d.url, author: d.author, tags: d.tags, path: d.path, readProgress: d.readProgress, core: c.core, axes: ax });
  }
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
  const deck = await cardCorpus(sample, axes, { concurrency: 8 });
  writeFileSync("deck-sample.jsonl", deckToJSONL(deck));
  const keys = axes.map((a: Axis) => a.key);
  const wellFormed = deck.filter((c) => c.core && keys.every((k: string) => c.axes[k]?.note !== undefined));
  console.log(`\n\ncarded ${deck.length}/${sample.length}; well-formed (core + all ${keys.length} axes): ${wellFormed.length}`);
  console.log("sample line:", JSON.stringify(deck[0]).slice(0, 160) + "…");
  console.log(wellFormed.length === deck.length && deck.length >= 12 ? "\n✅ card→deck stage works" : "\n⚠ malformed cards — inspect");
}
