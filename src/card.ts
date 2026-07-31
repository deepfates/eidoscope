import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { deriveCard } from "./signatures.ts";
import { provider } from "./provider.ts";
import type { Axis } from "./axes.ts";
import type { Doc } from "./corpus.ts";

// The gorm layer applied at scale: one deriveCard per document -> the DECK.
// The deck is the asset. One card per JSONL line: inspectable, diffable, appendable.
export type Card = { id: string; title: string; cat?: string; date?: number; url?: string; author?: string; tags?: string[]; path?: string; core: string; axes: Record<string, { score: number; note: string }> };

export const axesPrompt = (axes: Axis[]) =>
  axes.map((a, i) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

export async function cardCorpus(docs: Doc[], axes: Axis[], opts: { llm?: any; sig?: any; concurrency?: number; excerptChars?: number; cache?: string; onProgress?: (n: number) => void } = {}): Promise<Card[]> {
  const llm = opts.llm ?? provider();
  const sig = opts.sig ?? deriveCard;
  const conc = opts.concurrency ?? 12, cut = opts.excerptChars ?? 7000;
  const corpusAxes = axesPrompt(axes);

  // RESUMABLE: cards persist to a JSONL cache as they're produced (crash-safe, one card per line).
  // A rerun reloads finished cards and only re-cards the missing ids — a long gorm run survives a
  // hiccup instead of losing the whole deck. The cache is keyed to the axis set (header line); if
  // the axes change, the stale cache is discarded (those cards no longer describe these axes).
  const cacheFile = opts.cache;
  const axesKey = axes.map((a) => a.key).join("|");
  const done = new Map<string, Card>();
  if (cacheFile) {
    let ok = false;
    if (existsSync(cacheFile)) {
      const lines = readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
      try { if (JSON.parse(lines[0] || "{}").axesKey === axesKey) { ok = true; for (const l of lines.slice(1)) { try { const c = JSON.parse(l) as Card; done.set(c.id, c); } catch {} } } } catch {}
    }
    if (!ok) writeFileSync(cacheFile, JSON.stringify({ axesKey }) + "\n"); // fresh / axes changed
  }

  const q = docs.filter((d) => !done.has(d.id));
  const fresh: Card[] = [];
  let n = done.size;
  async function worker() {
    while (q.length) {
      const d = q.pop()!;
      try {
        const c: any = await sig.forward(llm, { documentTitle: d.title, documentBody: d.body.slice(0, cut), corpusAxes });
        const ax: Record<string, { score: number; note: string }> = {};
        axes.forEach((a, i) => { ax[a.key] = { score: Number(c.axisScores?.[i] ?? 50), note: String(c.axisNotes?.[i] ?? "") }; });
        const card: Card = { id: d.id, title: d.title, cat: d.cat, date: d.date, url: d.url, author: d.author, tags: d.tags, path: d.path, core: String(c.coreSummary ?? ""), axes: ax };
        fresh.push(card);
        if (cacheFile) appendFileSync(cacheFile, JSON.stringify(card) + "\n"); // durable the moment it's made
      } catch { /* skip a failed card */ }
      opts.onProgress?.(++n);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));

  // return in docs order (reused + fresh), skipping any that failed on both this run and prior
  const all = new Map(done); for (const c of fresh) all.set(c.id, c);
  return docs.map((d) => all.get(d.id)).filter(Boolean) as Card[];
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
