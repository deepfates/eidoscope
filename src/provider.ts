import { ai } from "@ax-llm/ax";
import { CFG } from "./config.ts";

// The Ax LLM. Any OpenAI-compatible endpoint works — OpenRouter (default), OpenAI, or a local
// Ollama (set EIDOSCOPE_API_URL=http://localhost:11434/v1). Only config.ts changes, never the
// gorm signatures. (Ax gotcha: it's `apiURL`, and the model lives under `config`.)
export function provider(model = CFG.model) {
  return ai({ name: "openai", apiKey: CFG.key, apiURL: CFG.apiURL, config: { model } } as any);
}
