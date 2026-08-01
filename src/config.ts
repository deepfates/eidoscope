// One place for everything corpus-specific. All env-overridable; no absolute paths, no local checkouts.
// Provider is any OpenAI-compatible endpoint (OpenRouter default; LM Studio / llama.cpp / vLLM local).
export const CFG = {
  model: process.env.EIDOSCOPE_MODEL ?? "google/gemini-3-flash-preview",
  apiURL: process.env.EIDOSCOPE_API_URL ?? "https://openrouter.ai/api/v1",
  embedModel: process.env.EIDOSCOPE_EMBED ?? "Xenova/all-MiniLM-L6-v2",
  key: process.env.OPENROUTER_API_KEY ?? process.env.EIDOSCOPE_API_KEY,
  // restatementWeight: the card is embedded as TWO pooled vectors — the restatement (specific content)
  // and the axis placements (shared positioning vocabulary) — combined restatement-dominant. Swept on two
  // corpora: ~0.7 is best-or-tied on both (AI topical 0.648, PF folder 0.773); averaging them flat (one
  // string) lets the placements drown the restatement. Tunable, later optimizable.
  params: { minChars: 400, topN: 16, minCoherence: 4, knn: 8, concurrency: 12, chunkWords: 220, maxChunks: 50, restatementWeight: 0.7 },
};
