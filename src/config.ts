import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// One place for everything corpus-specific. All env-overridable; no absolute paths, no local checkouts.
// Provider is any OpenAI-compatible endpoint (OpenRouter default; LM Studio / llama.cpp / vLLM local).
export const CFG = {
  model: process.env.EIDOSCOPE_MODEL ?? "google/gemini-3-flash-preview",
  apiURL: process.env.EIDOSCOPE_API_URL ?? "https://openrouter.ai/api/v1",
  embedModel: process.env.EIDOSCOPE_EMBED ?? "Xenova/all-MiniLM-L6-v2",
  key: process.env.OPENROUTER_API_KEY ?? process.env.EIDOSCOPE_API_KEY,
  // maxDocChars = the model's input ceiling for one card call. Docs above it are split to fit (corpus.ts
  // splitOversized) — the ONLY size rule, tied to a real limit, overridable for smaller-context models.
  params: { minChars: 400, topN: 16, minCoherence: 4, knn: 8, concurrency: 12, chunkWords: 220, maxChunks: 50, maxDocChars: Number(process.env.EIDOSCOPE_MAX_DOC_CHARS || 1_000_000) },
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

// The root itself, for the stores that take a DIRECTORY and pick their own filename inside it
// (card.ts -> card-cache.jsonl, regions.ts -> region-cache.jsonl). Migrates those names too.
export function cacheRoot(): string {
  for (const n of ["card-cache.jsonl", "region-cache.jsonl"]) cachePath(n);
  return CFG.cacheDir;
}
