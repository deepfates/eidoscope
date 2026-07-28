import { ai } from "@ax-llm/ax";
import { CFG } from "./config.ts";

// The Ax LLM. Any OpenAI-compatible endpoint works — OpenRouter (default), OpenAI, or a local
// server — LM Studio (http://localhost:1234/v1), llama.cpp, vLLM — via EIDOSCOPE_API_URL. Only config.ts changes, never the
// gorm signatures. (Ax gotcha: it's `apiURL`, and the model lives under `config`.)
export function provider(model = CFG.model) {
  return ai({ name: "openai", apiKey: CFG.key, apiURL: CFG.apiURL, config: { model } } as any);
}
