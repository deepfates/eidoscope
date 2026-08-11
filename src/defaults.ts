// Host-free defaults shared by BOTH faces of the engine (src/config.ts for the CLI, viewer/src/ingest.ts
// for the in-page pipeline). config.ts layers env-var overrides on top of these; the browser has no env,
// so it reads them directly. One definition — the two hosts can't drift on what the default model is.
export const DEFAULT_MODEL = "google/gemini-3-flash-preview";
export const DEFAULT_API_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
// chunkWords/maxChunks: the chunk-pooled embedding parameters (geometry.ts poolChunks) — identical on
// both hosts or the two faces would embed the same corpus into different vectors.
export const EMBED_PARAMS = { chunkWords: 220, maxChunks: 50 };
export const DEFAULT_MAX_DOC_CHARS = 1_000_000;
// How many card calls are in flight at once. ONE number for both hosts, set from measurement, because
// the two faces were silently disagreeing: the CLI used 48 while the page used 8, so the app told a
// user "5h23m" for work its own CLI finished in ~45 minutes (eid-7ll4).
// Measured 2026-08-10, sweeping a real page against a provider mock with 1.2s think-time per call:
//   level  4 → 3.3 calls/s · 8 → 6.7 · 16 → 13.3 · 32 → 26.6 · 48 → 39.8 · 64 → 39.8 (plateau)
// Linear to 48, flat past it — the same shape the node side measured, so 48 is the shared ceiling.
// (Client-side scheduling only: the real provider is the slower party, ~7.5 cards/s at this level.)
export const CARD_CONCURRENCY = 48;
// The INGEST-RUN refusal at this constant is gone (eid-yhj7): the engine runs in a Web Worker, so any
// corpus size runs without freezing the tab — the panel narrates a measured time estimate instead,
// and cancel is always live. The constant survives for CONNECTORS only: when a remote dataset's row
