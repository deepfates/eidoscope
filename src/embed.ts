import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { CFG } from "./config.ts";

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

// Embed items {id,text} -> unit-normalized MiniLM vectors, cached by id, order preserved.
export async function getTextEmbeddings(items: { id: string; text: string }[], opts: { cache?: EmbeddingCache; batch?: number; flushEvery?: number } = {}): Promise<number[][]> {
  const cache = opts.cache, batch = opts.batch ?? 32, flushEvery = opts.flushEvery ?? 160;
  const out: (number[] | null)[] = items.map((it) => cache?.get(it.id) ?? null);
  const misses = items.map((it, i) => ({ it, i })).filter((x) => out[x.i] === null);
  if (misses.length) {
    const ex = await extractor();
    let sinceFlush = 0;
    for (let b = 0; b < misses.length; b += batch) {
      const chunk = misses.slice(b, b + batch);
      const res: any = await ex(chunk.map((m) => m.it.text || " "), { pooling: "mean", normalize: true });
      const arr: number[][] = res.tolist();
      chunk.forEach((m, j) => { out[m.i] = arr[j]; cache?.set(m.it.id, arr[j]); });
      // persist periodically so a long/heavy pass is RESUMABLE — a crash or OOM keeps everything embedded
      // so far instead of losing the whole pass (the cache used to save only once, at the very end).
      if (cache && ++sinceFlush >= flushEvery) { await cache.save(); sinceFlush = 0; }
    }
    if (cache && sinceFlush) await cache.save();
  }
  return out as number[][];
}
