import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { CFG } from "./config.ts";
import { embedThroughCache } from "./embed-core.ts";

// Local text embeddings via transformers.js (MiniLM by default), with an on-disk cache by id.
// This is the same library curare wraps — used directly, so eidoscope needs no curare checkout.
// (sharp is a transitive dep of transformers.js for IMAGE inputs only; text never touches it.)

let _extractor: Promise<any> | null = null;
const extractor = () => (_extractor ??= pipeline("feature-extraction", CFG.embedModel));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

// Cache-compatible with how map.ts already calls it: new EmbeddingCache(dir, model) -> load()/save().
export class EmbeddingCache {
  private file: string;
  private map = new Map<string, number[]>();
  constructor(dir: string, model: string = CFG.embedModel) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, slug(model) + ".json");
  }
  async load() { try { if (existsSync(this.file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")))) this.map.set(k, v as number[]); } catch {} }
  async save() { writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map))); }
  get(id: string) { return this.map.get(id); }
  set(id: string, v: number[]) { this.map.set(id, v); }
}

// Embed items {id,text} -> unit-normalized MiniLM vectors, cached by id, order preserved. The NODE
// binding of the shared loop (src/embed-core.ts): a statically imported pipeline, the on-disk cache
// above, and periodic flushing so a long/heavy pass is RESUMABLE — a crash or OOM keeps everything
// embedded so far instead of losing the whole pass.
export async function getTextEmbeddings(items: { id: string; text: string }[], opts: { cache?: EmbeddingCache; batch?: number; flushEvery?: number } = {}): Promise<number[][]> {
  const cache = opts.cache, flushEvery = opts.flushEvery ?? 160;
  let sinceFlush = 0;
  const vecs = await embedThroughCache(items, async () => {
    const ex = await extractor();
    return async (texts) => (await ex(texts, { pooling: "mean", normalize: true })).tolist();
  }, {
    cache,
    batch: opts.batch ?? 32,
    onBatch: async (done) => {
      if (!cache || !done) return;
      if (++sinceFlush >= flushEvery) { await cache.save(); sinceFlush = 0; }
    },
  });
  if (cache && sinceFlush) await cache.save();
  return vecs;
}
