// One place for everything corpus-specific. All env-overridable; no absolute paths, no local checkouts.
// Provider is any OpenAI-compatible endpoint (OpenRouter default; LM Studio / llama.cpp / vLLM local).
export const CFG = {
  model: process.env.EIDOSCOPE_MODEL ?? "google/gemini-3-flash-preview",
  apiURL: process.env.EIDOSCOPE_API_URL ?? "https://openrouter.ai/api/v1",
  embedModel: process.env.EIDOSCOPE_EMBED ?? "Xenova/all-MiniLM-L6-v2",
  key: process.env.OPENROUTER_API_KEY ?? process.env.EIDOSCOPE_API_KEY,
  params: { minChars: 400, topN: 16, minCoherence: 4, knn: 8, concurrency: 12, excerptChars: 7000, chunkWords: 220, maxChunks: 50 },
};
