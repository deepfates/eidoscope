import { deriveCard, cardVer } from "./signatures.ts";
import { hash, Store, pool, withRetry, isAuthError, errLine } from "./llm.ts";
import type { Axis } from "./axes.ts";
import type { Doc } from "./corpus-core.ts";

// The gorm layer applied at scale -> the DECK. One full-text deriveCard call per document, cached by
// document content + the DETERMINISTIC axis geometry (PC index + variance). PCA is deterministic, so the
// same corpus yields the same axes every run; the LLM only relabels them, and those names are cosmetic
// and never touch the key — so re-running the same corpus reloads every card instead of re-carding.
//
// HOST-FREE (eid-bacg): the llm is always injected (CLI: provider(); page: an ax client from the
// user-held key), the cache is an injected Store (file-backed in node via config.fileStore, session
// memory in the page — which is what makes an in-page pass RESUMABLE: retrying re-runs only failures),
// and progress is a callback (node default: the stderr ticker).
export type Card = { id: string; title: string; cat?: string; date?: number; url?: string; source?: string; siteName?: string; author?: string; tags?: string[]; path?: string; readProgress?: number; meta?: Record<string, unknown>; core: string; axes: Record<string, { note: string }> };

export const axesPrompt = (axes: Axis[]) =>
  axes.map((a, i) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

export type CardProgress = (done: number, total: number, failed: number) => void;

export async function cardCorpus(docs: Doc[], axes: Axis[], opts: { llm?: any; sig?: any; concurrency?: number; cache?: Store; onProgress?: CardProgress } = {}): Promise<Card[]> {
  const llm = opts.llm;
  if (llm === undefined) throw new Error("cardCorpus: an llm client is required (the caller injects it)");
  const sig = opts.sig ?? deriveCard;
  const conc = opts.concurrency ?? 12;
  const corpusAxes = axesPrompt(axes);
  const cache = opts.cache ?? new Store();
  // key = document content + DETERMINISTIC axis geometry (PC index + variance). NOT the LLM labels.
  const geo = axes.map((a) => a.pc + ":" + (a.var ?? 0).toFixed(6)).join("|");
  const key = (d: Doc) => hash("card " + cardVer + " " + d.title + " " + d.body + " " + geo);

  const need = docs.filter((d) => !cache.has(key(d)));
  let done = 0, fail = 0, lastErr: any;
  const progress: CardProgress = opts.onProgress ?? ((dn, total) => { if (total && (dn % 50 === 0 || dn === total)) (globalThis as any).process?.stderr?.write?.(`  cards ${dn}/${total}\r`); });
  await pool(need, async (d) => {
    const r: any = await withRetry(() => sig.forward(llm, { documentTitle: d.title, documentText: d.body, corpusAxes }), 4, (e) => { lastErr = e; });
    if (r?.restatement) cache.put(key(d), { core: String(r.restatement), placements: (r.axisPlacements ?? []).map(String) });
    else {
      fail++;
      // An auth failure means EVERY call will fail identically — abort the run now with the provider's
      // own words, instead of burning through the corpus and emitting an empty map as a "success".
      if (lastErr && isAuthError(lastErr)) throw new Error(`the provider rejected the API key — ${errLine(lastErr)} (check OPENROUTER_API_KEY / EIDOSCOPE_API_KEY)`);
    }
    progress(++done, need.length, fail);
  }, conc);
  if (fail) console.error(`  ⚠ ${fail} cards failed after retries (reported, not silently dropped)`);

  const out: Card[] = [];
  for (const d of docs) {
    const c = cache.get(key(d)); if (!c) continue;
    const ax: Record<string, { note: string }> = {};
    axes.forEach((a, i) => { ax[a.key] = { note: String(c.placements?.[i] ?? "") }; });
    out.push({ id: d.id, title: d.title, cat: d.cat, date: d.date, url: d.url, source: d.source, siteName: d.siteName, author: d.author, tags: d.tags, path: d.path, readProgress: d.readProgress, meta: d.meta, core: c.core, axes: ax });
  }
  // A run where every card failed has produced nothing to map — that is a failure, and it must never
  // roll on to emit an empty .eido wearing a ✅. Name the underlying provider error once, plainly.
  if (docs.length && !out.length) throw new Error(`every card failed (${docs.length} docs, 0 cards)${lastErr ? ` — ${errLine(lastErr)}` : " — the model returned no usable output"}`);
  return out;
}

export const deckToJSONL = (cards: Card[]) => cards.map((c) => JSON.stringify(c)).join("\n") + "\n";

// verify: card a small sample against the fixture axes, check the deck shape
if ((import.meta as any).main) {
  const dyn = (m: string) => import(/* @vite-ignore */ m);   // node-only path, invisible to the browser bundler
  const { writeFileSync } = await dyn("node:fs");
  const { provider } = await dyn("./provider.ts");
  const { loadFixture, fixtureAxes } = await dyn("./corpus.ts");
  const { docs } = loadFixture();
  const axes = fixtureAxes();
  const sample = docs.filter((d: any) => d.body.length > 2000).slice(0, 15);
  console.error(`carding ${sample.length} sample docs over ${axes.length} axes...`);
  const deck = await cardCorpus(sample, axes, { llm: provider(), concurrency: 8 });
  writeFileSync("deck-sample.jsonl", deckToJSONL(deck));
  const keys = axes.map((a: Axis) => a.key);
  const wellFormed = deck.filter((c) => c.core && keys.every((k: string) => c.axes[k]?.note !== undefined));
  console.log(`\n\ncarded ${deck.length}/${sample.length}; well-formed (core + all ${keys.length} axes): ${wellFormed.length}`);
  console.log("sample line:", JSON.stringify(deck[0]).slice(0, 160) + "…");
  console.log(wellFormed.length === deck.length && deck.length >= 12 ? "\n✅ card→deck stage works" : "\n⚠ malformed cards — inspect");
}
