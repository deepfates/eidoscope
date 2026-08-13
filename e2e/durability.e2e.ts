// E2E for CACHE DURABILITY ACROSS A BROWSER RESTART (eid-ext6). A long ingest costs real money; the
// promise that cached work survives is therefore load-bearing, and it was never tested across a
// browser lifetime — only within one. This drives the real app in a PERSISTENT on-disk profile,
// ingests a corpus, KILLS the browser, relaunches on the same profile, and re-ingests the same
// corpus: the second run must mount with ZERO card calls (every card served from the cache).
// Hermetic: LLM mocked at the network edge, embedder served from local node_modules.
// Run: bun run e2e/durability.e2e.ts   (requires `cd viewer && bun run build`)
import { chromium, type BrowserContext } from "playwright";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The compute section (eid-rcm8) is collapsed for a reader who ALREADY has a key — the panel shows a
// summary instead. A run that needs to type a key therefore opens it first, the way a person would.
const openComputeIfCollapsed = async (pg: any) => {
  if (await pg.locator("[data-testid=ingest-key]").count()) return;
  const t = pg.locator("[data-testid=compute-toggle]");
  if (await t.count()) await t.click();
};


const LOG = join(tmpdir(), "eido-durability-e2e.log");   // progress on disk: a hang must be visible, never silent
const t0 = Date.now();
const log = (...a: unknown[]) => appendFileSync(LOG, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}\n`);
log("\n===== RUN " + new Date().toISOString() + " =====");
setTimeout(() => { log("WATCHDOG 420s reached — exiting so the hang is visible"); process.exit(3); }, 420_000);
const step = async <T>(name: string, fn: () => Promise<T>, ms = 60_000): Promise<T> => {
  log("→", name);
  const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT at step: " + name)), ms))]);
  log("✓", name);
  return r;
};

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "viewer", "dist", "index.html"));
const TDIST = join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
const TMODEL = join(ROOT, "node_modules", "@huggingface", "transformers", ".cache", "Xenova", "all-MiniLM-L6-v2");

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/map.eido") return new Response("not here", { status: 404 });
    if (path.startsWith("/tfwasm/")) { const f = join(TDIST, path.slice("/tfwasm/".length)); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    const hf = path.match(/^\/hf\/.*all-MiniLM-L6-v2\/resolve\/[^/]+\/(.+)$/);
    if (hf) { const f = hf[1].startsWith("onnx/") ? join(TMODEL, "onnx", "model.onnx") : join(TMODEL, hf[1]); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    if (path.startsWith("/hf/")) return new Response("", { status: 404 });
    return new Response(indexHtml, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;
log("server on", base);

const corpusDir = mkdtempSync(join(tmpdir(), "eido-dur-corpus-"));
for (const t of [
  { name: "volcano", words: "magma lava eruption caldera basalt pyroclastic vent fissure tephra stratovolcano" },
  { name: "pastry", words: "croissant laminated butter dough proofing viennoiserie ganache choux tart glaze" },
  { name: "sailing", words: "spinnaker halyard jib tack gybe keel windward leeward mainsail rigging" },
]) for (let i = 0; i < 4; i++) {
  const body = Array.from({ length: 8 }, (_, s) => `Notes on ${t.name} session ${i} part ${s}: ${t.words} — observed in study ${i}.${s}.`).join("\n\n");
  writeFileSync(join(corpusDir, `${t.name}-${i}.md`), `# ${t.name} study ${i}\n\n${body}\n`);
}

let cardCalls = 0;
function mockLLM(bodyStr: string): string {
  const body = JSON.parse(bodyStr);
  const sys: string = body.messages[0]?.content ?? "";
  const user: string = body.messages[body.messages.length - 1]?.content ?? "";
  let content = "";
  if (sys.includes("`Restatement`")) {
    cardCalls++;
    const title = (user.match(/Document Title:\s*([^\n]+)/) || [])[1]?.trim() ?? "untitled";
    const nAxes = (user.match(/^\s*\d+\.\s/gm) || []).length || 2;
    content = `Restatement: MOCKCORE restatement of ${title}.\nAxis Placements:\n` + Array.from({ length: nAxes }, (_, i) => `- sits mid-field on axis ${i + 1}`).join("\n");
  } else if (sys.includes("`Axis Names`")) {
    const n = (user.match(/AXIS \d+/g) || []).length || 2;
    const mk = (f: (i: number) => string) => Array.from({ length: n }, (_, i) => "- " + f(i + 1)).join("\n");
    content = `Axis Names:\n${mk((i) => `mock contrast ${i}`)}\nLow Pole Labels:\n${mk((i) => `low pole ${i}`)}\nHigh Pole Labels:\n${mk((i) => `high pole ${i}`)}\nCoherence Scores:\n${mk(() => "4")}`;
  } else if (sys.includes("`Region Label`")) {
    const term = (user.match(/Distinctive Terms:\s*([^,\n]+)/) || [])[1]?.trim() ?? "region";
    content = `Region Label: R-${term}\nRegion Blurb: blurb about ${term}`;
  }
  return JSON.stringify({ id: "mock", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
}

const PROFILE = join(tmpdir(), "eido-app-persistent-profile");
mkdirSync(PROFILE, { recursive: true });

async function wire(ctx: BrowserContext) {
  await ctx.route("https://openrouter.ai/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: mockLLM(route.request().postData() ?? "{}") }));
  await ctx.addInitScript(`window.__EIDO_TF_HOST = ${JSON.stringify(base + "/hf/")}; window.__EIDO_TF_WASM = ${JSON.stringify(base + "/tfwasm/")};`);
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => (/openrouter\.ai/.test(route.request().url()) ? route.fallback() : route.abort()));
}

const READ_OPFS = `(async () => {
  const root = await navigator.storage.getDirectory(); const out = {};
  try { const d = await root.getDirectoryHandle("eido-cache"); for await (const [n, h] of d.entries()) if (h.kind === "file") out[n] = (await (await d.getFileHandle(n)).getFile()).size; } catch (e) { out.__err = String(e); }
  return JSON.stringify({ files: out, persisted: await navigator.storage.persisted() });
})()`;

async function ingest(ctx: BrowserContext, label: string) {
  const p = await step(`${label}: newPage`, () => ctx.newPage());
  p.on("pageerror", (e) => log("  PAGEERR", String(e).slice(0, 180)));
  p.on("console", (m) => { if (m.type() === "error") log("  CONSOLE-ERR", m.text().slice(0, 140)); });
  await step(`${label}: goto`, () => p.goto(base + "/index.html"));
  await step(`${label}: wait open-folder`, () => p.waitForSelector("[data-testid=open-folder]", { state: "attached", timeout: 20000 }));
  await step(`${label}: setInputFiles`, () => p.setInputFiles("[data-testid=open-folder]", corpusDir));
  await step(`${label}: wait key gate`, async () => { await p.waitForSelector("[data-testid=compute]", { timeout: 20000 }); await openComputeIfCollapsed(p); await p.waitForSelector("[data-testid=ingest-key]", { timeout: 20000 }); });
  await step(`${label}: fill key`, () => p.fill("[data-testid=ingest-key]", "sk-or-e2e-test"));
  await step(`${label}: click start`, () => p.click("[data-testid=ingest-start]"));
  const tick = setInterval(async () => {
    try { log("   status:", (await p.locator("[data-testid=ingest-status]").textContent())?.replace(/\s+/g, " ").slice(0, 100)); } catch {}
  }, 5000);
  try {
    await step(`${label}: wait mount`, () => p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 180000 }), 190_000);
  } finally { clearInterval(tick); }
  await p.waitForTimeout(2500);
  log(`${label}: MOUNTED — cardCalls=${cardCalls} opfs=${await p.evaluate(READ_OPFS)}`);
}

try {
  let ctx = await step("launch #1 (persistent)", () => chromium.launchPersistentContext(PROFILE, { headless: true }));
  await wire(ctx);
  await ingest(ctx, "run1");
  const firstRunCards = cardCalls;
  await step("close #1", () => ctx.close());
  log("browser closed. cards written run1 =", firstRunCards);

  cardCalls = 0;
  ctx = await step("launch #2 (same profile)", () => chromium.launchPersistentContext(PROFILE, { headless: true }));
  await wire(ctx);
  await ingest(ctx, "run2");
  await step("close #2", () => ctx.close());
  const reused = cardCalls === 0;
  log(`VERDICT: run2 card calls = ${cardCalls}`);
  console.log(reused
    ? "  ✓ the cache survived a full browser restart — the second ingest spent ZERO card calls"
    : `  ✗ cache did NOT survive the restart — the second ingest re-spent ${cardCalls} card calls`);
  console.log(reused ? "\n✅ durability e2e: cached work outlives the browser\n" : "\n✗ durability e2e FAILED\n");
  server.stop();
  process.exit(reused ? 0 : 1);
} catch (e) {
  log("ERROR:", String(e).slice(0, 400));
  console.error("✗ durability e2e error:", String(e).slice(0, 300), "\n   progress log:", LOG);
  server.stop();
  process.exit(1);
}
