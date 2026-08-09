import { existsSync, mkdirSync, renameSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./llm.ts";
import { DEFAULT_MODEL, DEFAULT_API_URL, DEFAULT_EMBED_MODEL, DEFAULT_MAX_DOC_CHARS, EMBED_PARAMS } from "./defaults.ts";

// One place for everything corpus-specific ON THE NODE HOST. All env-overridable; no absolute paths,
// no local checkouts. The host-free defaults live in src/defaults.ts (shared with the in-page engine);
// this file layers env overrides + filesystem caching on top. Provider is any OpenAI-compatible
// endpoint (OpenRouter default; LM Studio / llama.cpp / vLLM local).
export const CFG = {
  model: process.env.EIDOSCOPE_MODEL ?? DEFAULT_MODEL,
  apiURL: process.env.EIDOSCOPE_API_URL ?? DEFAULT_API_URL,
  embedModel: process.env.EIDOSCOPE_EMBED ?? DEFAULT_EMBED_MODEL,
  key: process.env.OPENROUTER_API_KEY ?? process.env.EIDOSCOPE_API_KEY,
  // maxDocChars = the model's input ceiling for one card call. Docs above it are split to fit (corpus.ts
  // splitOversized) — the ONLY size rule, tied to a real limit, overridable for smaller-context models.
  params: { minChars: 400, topN: 16, minCoherence: 4, knn: 8, concurrency: 12, ...EMBED_PARAMS, maxDocChars: Number(process.env.EIDOSCOPE_MAX_DOC_CHARS || DEFAULT_MAX_DOC_CHARS) },
  // ONE cache root instead of five siblings littering whatever directory you happened to run from
  // (card-cache.jsonl, region-cache.jsonl, cache-eidoscope-cards/, cache-eidoscope-fulltext/, s2-cache.json).
  // Deleting a cache is now `rm -rf .eidoscope-cache`, and the tree can be gitignored as one entry.
  cacheDir: process.env.EIDOSCOPE_CACHE_DIR ?? ".eidoscope-cache",
};

// Resolve a cache entry inside the root, creating it, and MIGRATE the pre-namespacing file/dir of the
// same name by rename if one is still sitting in CWD — a rename is atomic and cheap, so an existing
// (possibly very expensive) card or embedding cache keeps working instead of silently re-embedding.
// Rename rather than dual-read: one location to reason about, no code path that outlives the migration.
export function cachePath(name: string): string {
  if (!existsSync(CFG.cacheDir)) mkdirSync(CFG.cacheDir, { recursive: true });
  const to = join(CFG.cacheDir, name);
  if (!existsSync(to) && existsSync(name)) { try { renameSync(name, to); } catch {} }
  return to;
}

// The root itself, for callers that keep several caches under it.
export function cacheRoot(): string {
  for (const n of ["card-cache.jsonl", "region-cache.jsonl"]) cachePath(n);
  return CFG.cacheDir;
}

// The node persistence adapter for the (host-free) llm.ts Store: a .jsonl file, appended per entry so a
// crash keeps everything already computed. This is the ONLY place a cache Store touches the filesystem.
export const fileStore = (file: string): Store =>
  new Store({ read: () => (existsSync(file) ? readFileSync(file, "utf8") : undefined), append: (l) => appendFileSync(file, l) });

// A named cache Store inside the cache root (migrating the pre-namespacing file if present).
export const cacheStore = (name: string): Store => fileStore(cachePath(name));
