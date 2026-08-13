// THE COMPUTE IS THE READER'S CHOICE (eid-rcm8) — which model names and cards, which embedder runs the
// vectors and where, and what each configuration actually costs, stated at the moment of choosing.
//
// This is not a settings page. It is the honesty discipline applied to compute: the instrument exposes
// its real operating points with their real consequences, the way an instrument does, instead of hiding
// one hardcoded provider behind a key field. The engine has always supported this — src/provider.ts takes
// any OpenAI-compatible endpoint and model (EIDOSCOPE_API_URL / EIDOSCOPE_MODEL), so the CLI could always
// point at LM Studio. Only the app couldn't ask. This module is the asking.
//
// NOTHING HERE IS A SHIPPED PRICE TABLE. Prices come from the endpoint's own /models response, live, so
// they cannot go stale and no number is hand-carved. An endpoint that does not report pricing (LM Studio,
// llama.cpp, vLLM) is reported as free, which is the truth: local compute costs time, not dollars.
import { DEFAULT_MODEL, DEFAULT_API_URL, DEFAULT_EMBED_MODEL } from "../../src/defaults";

export type Compute = {
  apiURL: string;    // any OpenAI-compatible base URL
  model: string;     // the model that writes cards and names axes/regions
  key: string;       // user-held; localStorage only, never written into any file
  embedder: string;  // HuggingFace id of the sentence embedder that makes the vectors
  device: "auto" | "wasm";   // where the embedder runs: auto = WebGPU when an adapter exists
};

export type ModelInfo = {
  id: string;
  name: string;
  promptUsd: number;      // USD per prompt token (0 = endpoint reports no pricing, i.e. local)
  completionUsd: number;  // USD per completion token
  context: number | null;
  free: boolean;          // the endpoint reported no pricing at all — not "cheap", but "not billed here"
};

// Endpoint presets. `local` ones are marked so the UI can say plainly that no key is needed and no
// dollars are spent — the same honest branch the engine already makes on environment, not on data size.
export const PRESETS = [
  { label: "OpenRouter", apiURL: DEFAULT_API_URL, local: false, keyHint: "sk-or-…", note: "hundreds of models, one key. The page calls it directly — nothing passes through any server of ours." },
  { label: "LM Studio", apiURL: "http://localhost:1234/v1", local: true, keyHint: "(none needed)", note: "a model running on this machine. Free, private, and as fast as your hardware — start the server in LM Studio first." },
  { label: "Ollama", apiURL: "http://localhost:11434/v1", local: true, keyHint: "(none needed)", note: "a model running on this machine through Ollama's OpenAI-compatible endpoint." },
] as const;

// Parse the host rather than prefix-matching the string: a prefix test calls `https://localhost.evil.com`
// local, and this predicate decides whether the panel tells the reader "no key needed, runs on your
// machine" — so getting it wrong misdescribes where their documents are being sent. Caught by a test.
export const isLocal = (apiURL: string): boolean => {
  try {
    const h = new URL(apiURL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch { return false; }
};

// Embedders we can actually run in the page: transformers.js ONNX sentence encoders. The dimension is
// the vector width the whole map is built in — a map's own embedder id is stamped in the .eido
// (derivedBy.embedder) so a later query embeds in the SAME space the cards were built in.
export const EMBEDDERS = [
  { id: DEFAULT_EMBED_MODEL, label: "MiniLM-L6 (384d)", note: "the default: small, fast, ~23MB. Reads about 256 tokens per chunk." },
  { id: "Xenova/all-MiniLM-L12-v2", label: "MiniLM-L12 (384d)", note: "twice the depth of L6, same width and roughly twice the time." },
  { id: "Xenova/bge-small-en-v1.5", label: "BGE-small-en (384d)", note: "stronger on retrieval-style relatedness in published benchmarks; English only." },
] as const;

const STORAGE = "eido-compute";
// the pre-compute key field (viewer/src/ingest.ts KEY_STORAGE). Read once so an existing reader keeps
// their key through this change; nothing writes it again — the migration finishes rather than lingering.
const LEGACY_KEY = "eido-llm-key";

export const defaultCompute = (): Compute => ({
  apiURL: DEFAULT_API_URL, model: DEFAULT_MODEL, key: "", embedder: DEFAULT_EMBED_MODEL, device: "auto",
});

// The key rides inside Compute because it belongs to the endpoint, not to the app — pointing at LM Studio
// and pointing at OpenRouter are two different credentials. Stored per this browser, never in a file.
export function loadCompute(): Compute {
  const d = defaultCompute();
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return { ...d, key: localStorage.getItem(LEGACY_KEY) ?? "" };   // carry the pre-compute key field over
    const p = JSON.parse(raw) as Partial<Compute>;
    return {
      apiURL: typeof p.apiURL === "string" && p.apiURL ? p.apiURL : d.apiURL,
      model: typeof p.model === "string" && p.model ? p.model : d.model,
      key: typeof p.key === "string" ? p.key : "",
      embedder: typeof p.embedder === "string" && p.embedder ? p.embedder : d.embedder,
      device: p.device === "wasm" ? "wasm" : "auto",
    };
  } catch { return d; }
}

export function saveCompute(c: Compute): void {
  try { localStorage.setItem(STORAGE, JSON.stringify(c)); } catch {}
}

// ── the model registry, fetched from whatever endpoint is selected ───────────────────────────────────
// GET {apiURL}/models is the OpenAI-compatible listing every one of these servers speaks. OpenRouter
// answers it with `access-control-allow-origin: *` and no key (verified 2026-08-12, 409 models), and its
// rows carry real per-token pricing — so the picker and the price come from ONE call and neither is ours
// to keep up to date. LM Studio and Ollama answer the same shape without pricing.
export async function listModels(apiURL: string, key = "", fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const url = apiURL.replace(/\/+$/, "") + "/models";
  const res = await fetchImpl(url, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`);
  const body = await res.json();
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  if (!rows.length) throw new Error(`${url} returned no models`);
  return rows.map((r) => {
    const p = Number(r?.pricing?.prompt ?? NaN), c = Number(r?.pricing?.completion ?? NaN);
    const priced = Number.isFinite(p) && Number.isFinite(c);
    return {
      id: String(r?.id ?? ""),
      name: String(r?.name ?? r?.id ?? ""),
      promptUsd: priced ? p : 0,
      completionUsd: priced ? c : 0,
      context: Number.isFinite(Number(r?.context_length)) ? Number(r.context_length) : null,
      free: !priced || (p === 0 && c === 0),
    };
  }).filter((m) => m.id);
}

// ── what a configuration will cost, before a single call is made ─────────────────────────────────────
// Two inputs, both real: the corpus's own measured size, and the model's own published per-token price.
// Two conversion figures, both stated rather than buried:
//
//   CHARS_PER_TOKEN = 4 — the standard approximation for English text under a BPE tokenizer. An
//   APPROXIMATION, and named as one; it is the only unmeasured number in this estimate.
//
//   CARD_COMPLETION_TOKENS = 935 — MEASURED, not guessed: the mean card (title + restatement + one
//   placement per axis) across the shipped 19,299-document Pitchfork map is 3,739 characters
//   (out/pitchfork/pitchfork.eido, measured 2026-08-12), which is ~935 tokens at the ratio above.
//
// Deliberately NOT included, and said so in the UI rather than hidden: the per-call axes preamble (its
// size is unknown until axes are discovered) and region naming (a few hundred short calls, whose count
// depends on the grain ladder the corpus turns out to have). Both make this a FLOOR. Once carding starts,
// the panel stops estimating and reports the rate it is actually measuring, as every other stage does.
export const CHARS_PER_TOKEN = 4;
export const CARD_COMPLETION_TOKENS = 935;

export type Estimate = { promptTokens: number; completionTokens: number; usd: number | null; free: boolean };

// A local endpoint bills nothing, and we know that from the URL alone — before any model list loads.
// Saying "price unknown" there would be false modesty about the one thing we are certain of.
export const LOCAL_FREE: ModelInfo = { id: "", name: "local", promptUsd: 0, completionUsd: 0, context: null, free: true };

export function estimate(corpusChars: number, docs: number, m: ModelInfo | null): Estimate {
  const promptTokens = Math.round(corpusChars / CHARS_PER_TOKEN);
  const completionTokens = Math.round(docs * CARD_COMPLETION_TOKENS);
  if (!m) return { promptTokens, completionTokens, usd: null, free: false };
  if (m.free) return { promptTokens, completionTokens, usd: 0, free: true };
  return { promptTokens, completionTokens, usd: promptTokens * m.promptUsd + completionTokens * m.completionUsd, free: false };
}

export const fmtUsd = (usd: number): string =>
  usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : "<$0.01";

export const fmtTokens = (t: number): string =>
  t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${Math.round(t / 1e3)}k` : String(t);
