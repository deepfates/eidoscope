import { readFileSync } from "node:fs";

// One place for everything corpus-specific. All env-overridable; no scattered absolute paths.
// (curare isn't on npm yet, so it's a configurable path to the local checkout for now.)
function resolveKey(): string | undefined {
  let k = process.env.OPENROUTER_API_KEY ?? process.env.EIDOSCOPE_API_KEY;
  if (!k) { try { k = (readFileSync("/Users/deepfates/Hacking/github/deepfates/curare/.env", "utf8").match(/OPENROUTER_API_KEY=(.+)/) || [])[1]?.trim(); } catch {} }
  return k;
}

export const CFG = {
  curare: process.env.EIDOSCOPE_CURARE ?? "/Users/deepfates/Hacking/github/deepfates/curare/dist/index.js",
  model: process.env.EIDOSCOPE_MODEL ?? "google/gemini-3-flash-preview",
  apiURL: process.env.EIDOSCOPE_API_URL ?? "https://openrouter.ai/api/v1",
  embedModel: process.env.EIDOSCOPE_EMBED ?? "Xenova/all-MiniLM-L6-v2",
  key: resolveKey(),
  params: { minChars: 400, topN: 16, minCoherence: 4, knn: 8, concurrency: 12, excerptChars: 7000, chunkWords: 220, maxChunks: 50 },
};

export const curare = () => import(CFG.curare) as Promise<any>;
