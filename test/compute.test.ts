// The compute choice (eid-rcm8) — the model registry and the spend estimate. These matter more than
// most tests here because the estimate makes a claim about the reader's MONEY before they spend it.
import { test, expect } from "bun:test";
import { listModels, estimate, runEstimate, fmtDuration, isLocal, loadCompute, defaultCompute, CARD_COMPLETION_TOKENS, CHARS_PER_TOKEN, EMBED_DOCS_PER_SEC, CARD_DOCS_PER_SEC, type ModelInfo } from "../viewer/src/compute";

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, statusText: ok ? "OK" : "Bad", json: async () => body }) as unknown as Response;
const fetchOf = (body: unknown, ok = true, status = 200) => (async () => res(body, ok, status)) as unknown as typeof fetch;

const priced: ModelInfo = { id: "m", name: "m", promptUsd: 1e-6, completionUsd: 4e-6, context: 1000, free: false };

test("an OpenRouter-shaped listing carries real per-token pricing through", async () => {
  const ms = await listModels("https://openrouter.ai/api/v1", "", fetchOf({
    data: [{ id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash", context_length: 1048576, pricing: { prompt: "0.0000005", completion: "0.0000025" } }],
  }));
  expect(ms).toHaveLength(1);
  expect(ms[0].promptUsd).toBe(5e-7);
  expect(ms[0].completionUsd).toBe(2.5e-6);
  expect(ms[0].context).toBe(1048576);
  expect(ms[0].free).toBe(false);
});

// LM Studio / Ollama answer the same endpoint without a pricing block. That is not "cheap" — it is
// "not billed here", and the UI says so rather than printing a fake $0.00 next to a hosted model.
test("an endpoint that reports no pricing is free, not zero-cost-by-accident", async () => {
  const ms = await listModels("http://localhost:1234/v1", "", fetchOf({ data: [{ id: "qwen3-8b" }] }));
  expect(ms[0].free).toBe(true);
  expect(estimate(400_000, 100, ms[0])).toMatchObject({ usd: 0, free: true });
});

test("a trailing slash on the base URL does not produce a double slash", async () => {
  let seen = "";
  const f = (async (u: string) => { seen = u; return res({ data: [{ id: "x" }] }); }) as unknown as typeof fetch;
  await listModels("https://openrouter.ai/api/v1/", "", f);
  expect(seen).toBe("https://openrouter.ai/api/v1/models");
});

test("a refusing endpoint reports its status rather than pretending it has no models", async () => {
  expect(listModels("https://openrouter.ai/api/v1", "", fetchOf({}, false, 401))).rejects.toThrow(/401/);
});

test("an endpoint that answers with an empty list says so", async () => {
  expect(listModels("http://localhost:1234/v1", "", fetchOf({ data: [] }))).rejects.toThrow(/no models/);
});

// The estimate's arithmetic, pinned: prompt from the corpus's own measured characters, completion from
// the per-card figure measured on the shipped Pitchfork map. If either constant is edited, this fails.
test("the estimate is corpus chars in, measured card size out, at the model's own price", () => {
  const e = estimate(4_000_000, 1_000, priced);
  expect(e.promptTokens).toBe(4_000_000 / CHARS_PER_TOKEN);
  expect(e.completionTokens).toBe(1_000 * CARD_COMPLETION_TOKENS);
  expect(e.usd).toBeCloseTo(1_000_000 * 1e-6 + 935_000 * 4e-6, 6);
});

test("with no model chosen the token counts still stand and only the price is unknown", () => {
  const e = estimate(4_000_000, 1_000, null);
  expect(e.usd).toBeNull();
  expect(e.promptTokens).toBeGreaterThan(0);
  expect(e.completionTokens).toBeGreaterThan(0);
});

// Sanity against reality: the shipped Pitchfork run was 19,299 documents of ~110MB for $80.96 on
// gemini-3-flash (prompt $0.30/M, completion $2.50/M at the time of writing). The estimate should land
// in the same order of magnitude — it is a floor (no axes preamble, no region naming), never a ceiling.
test("the estimate lands in the right order of magnitude on a run we actually paid for", () => {
  const flash: ModelInfo = { id: "google/gemini-3-flash-preview", name: "f", promptUsd: 3e-7, completionUsd: 2.5e-6, context: 1e6, free: false };
  const e = estimate(110_000_000, 19_299, flash);
  expect(e.usd).toBeGreaterThan(20);
  expect(e.usd).toBeLessThan(200);
});

test("localhost endpoints are recognised as local, hosted ones are not", () => {
  expect(isLocal("http://localhost:1234/v1")).toBe(true);
  expect(isLocal("http://127.0.0.1:11434/v1")).toBe(true);
  expect(isLocal("https://openrouter.ai/api/v1")).toBe(false);
  expect(isLocal("https://localhost.evil.com/v1")).toBe(false);   // not a prefix match by accident
});

// A reader who had a key before this change keeps it: the old lone key field is read once on load.
test("the pre-compute key field is carried into the new shape", () => {
  const store = new Map<string, string>([["eido-llm-key", "sk-or-old"]]);
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  expect(loadCompute()).toMatchObject({ key: "sk-or-old", model: defaultCompute().model });
  delete (globalThis as any).localStorage;
});

// ── HOW LONG, AND WHAT WON'T FINISH HERE (eid-jgjb a + c) ────────────────────────────────────────────
// The point of these is restraint: the estimate must decline to answer where nothing was measured,
// because a confident wrong hour is worse than an admitted unknown when someone is about to spend money.
test("a small corpus on WebGPU gets a whole-run time from measured rates", () => {
  const r = runEstimate(400_000, 1_000, priced, "auto");
  const embed = r.stages.find((s) => s.name === "embed")!;
  const card = r.stages.find((s) => s.name === "write cards")!;
  expect(embed.seconds).toBeCloseTo(1_000 / EMBED_DOCS_PER_SEC, 3);
  expect(card.seconds).toBeCloseTo(1_000 / CARD_DOCS_PER_SEC, 3);
  expect(r.beyondMeasured).toBe(false);
  // and it produces a REAL total, not a null. My first cut returned null whenever any stage was
  // untimed — and layout never is — so the total was null for every corpus and the UI branch was dead.
  expect(r.totalSeconds).toBeGreaterThan(0);
  expect(r.totalSeconds).toBeCloseTo(1_000 / EMBED_DOCS_PER_SEC + 1_000 / CARD_DOCS_PER_SEC, 3);
});

test("on wasm the embed stage is reported as untimed rather than guessed at", () => {
  const r = runEstimate(400_000, 1_000, priced, "wasm");
  const embed = r.stages.find((s) => s.name === "embed")!;
  expect(embed.seconds).toBeNull();
  expect(embed.why).toMatch(/never timed/i);
});

// The one that matters most: a partial sum is fine to show, but must be LABELLED as partial, and the
// caller must be able to name which stages are missing rather than implying the total covers them.
test("a partial total is still a number, but it says which stages it does not cover", () => {
  const r = runEstimate(400_000, 1_000, priced, "wasm");
  expect(r.timedAll).toBe(false);
  expect(r.untimed).toContain("embed");
  expect(r.untimed).toContain("layout + regions");
  expect(r.totalSeconds).toBeCloseTo(1_000 / CARD_DOCS_PER_SEC, 3);   // carding only — embed is untimed on wasm
});

test("a corpus larger than anything taken through a tab is flagged, and its layout is not timed", () => {
  const r = runEstimate(400_000_000, 1_000_000, priced, "auto");
  expect(r.beyondMeasured).toBe(true);
  const layout = r.stages.find((s) => s.name === "layout + regions")!;
  expect(layout.seconds).toBeNull();
  expect(layout.why).toMatch(/CLI host, not a tab/);
  expect(r.timedAll).toBe(false);        // so the panel must not present the total as the whole run
  expect(r.untimed).toContain("layout + regions");
});

// Sanity against the run we actually paid for: 19,299 Pitchfork documents. Carding at the measured rate
// is ~43 min; the ticket's own figure for that corpus is in the same neighbourhood.
test("the carding time lands where the real Pitchfork run landed", () => {
  const r = runEstimate(110_000_000, 19_299, priced, "auto");
  const card = r.stages.find((s) => s.name === "write cards")!.seconds!;
  expect(card / 60).toBeGreaterThan(30);
  expect(card / 60).toBeLessThan(60);
});

test("durations read as a person would say them, not as raw seconds", () => {
  expect(fmtDuration(45)).toBe("45s");
  expect(fmtDuration(600)).toBe("10 min");
  expect(fmtDuration(3600 * 2.5)).toBe("2.5 hours");
  expect(fmtDuration(3600 * 37)).toBe("37 hours");
});
