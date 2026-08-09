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

// The in-page envelope (docs/ARCHITECTURE.md "The loops → Ingest"): comfortable to ~2–5k docs in-page
// (measured: 5k-doc layout 2.9s in-browser; the wall is embed+card time). Past this the app refuses
// honestly and points at the CLI twin rather than hanging a tab for an hour.
export const INPAGE_ENVELOPE_DOCS = 5000;
