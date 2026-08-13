// ONE implementation of "strings → vectors, through a cache, in order" (eid-sh90).
//
// Both hosts embed with the SAME npm package (@huggingface/transformers) and had grown their own copy of
// the same twelve lines: look every id up in a cache, collect the misses, run them through the extractor
// in batches, write each result back to both the output array and the cache, keep the caller's order.
// deepfates ruled against exactly that duplication on 2026-08-10 — "I don't believe there should be
// different implementations between the two versions" — so the algorithm lives here once and the two
// hosts inject what is genuinely theirs:
//
//   node    (src/embed.ts)          — a static import, a JSON file cache, periodic flushing, batch 32
//   browser (viewer/src/embedder.ts) — a dynamic import, a device choice, test seams, download progress,
//                                      a session map over an OPFS Store, a yield so the UI paints, batch 16
//
// None of those differences is a fork in the algorithm; they are host bindings, which is why they stay
// outside. What must never differ — batching, cache write-back, ordering, the empty-text guard — is here.

// A vector store keyed by the caller's own id. Both hosts already had this shape; neither has to change.
export type EmbedCache = {
  get(id: string): number[] | undefined;
  set(id: string, v: number[]): void;
};

// The bound model: a batch of texts in, one vector per text out, already mean-pooled and normalized.
// Host-free by construction — whoever builds it has already chosen the device, the weights and the origin.
export type Extractor = (texts: string[]) => Promise<number[][]>;

export type EmbedThroughOpts = {
  cache?: EmbedCache;
  batch?: number;
  // Called after every batch with cumulative progress. Awaited, so a host can do real work in it: node
  // flushes its cache file periodically (making a long pass resumable), the browser yields to the event
  // loop so the progress bar actually paints. Also called once up front, so a fully-cached pass still
  // reports 100% instead of looking stalled.
  onBatch?: (done: number, total: number) => void | Promise<void>;
};

export async function embedThroughCache(
  items: { id: string; text: string }[],
  extractor: () => Promise<Extractor>,
  opts: EmbedThroughOpts = {},
): Promise<number[][]> {
  const { cache, batch = 16, onBatch } = opts;
  const out: (number[] | null)[] = items.map((it) => cache?.get(it.id) ?? null);
  const misses = items.map((it, i) => ({ it, i })).filter((x) => out[x.i] === null);

  let done = items.length - misses.length;
  await onBatch?.(done, items.length);
  // Every id was already cached: return without touching the extractor, so a fully-warm pass never pays
  // the model load (in the browser that is a ~23MB download that would otherwise happen for nothing).
  if (!misses.length) return out as number[][];

  const ex = await extractor();
  for (let b = 0; b < misses.length; b += batch) {
    const chunk = misses.slice(b, b + batch);
    // " " for an empty string: the tokenizer rejects a truly empty input, and a caller asking for the
    // embedding of nothing should get a valid vector rather than an exception from three layers down.
    const vecs = await ex(chunk.map((m) => m.it.text || " "));
    chunk.forEach((m, j) => { out[m.i] = vecs[j]; cache?.set(m.it.id, vecs[j]); });
    done += chunk.length;
    await onBatch?.(done, items.length);
  }
  return out as number[][];
}
