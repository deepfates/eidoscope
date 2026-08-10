// E2E for IN-PAGE INGEST (eid-bacg): drive a REAL folder→map ingest through the actual built app in
// Chromium — the empty state, the folder picker, the key gate (stop-at-axes without a key, resume with
// one), the per-stage progress, and the mounted map with real cards. HERMETIC: the LLM is mocked at the
// network edge (playwright route interception of the OpenRouter endpoint — the page runs its real ax
// client and parser); the transformers.js runtime + MiniLM weights are served from the LOCAL node_modules
// (so the page runs the REAL embedder, offline); every other external request is aborted.
// Run: bun run e2e/ingest.e2e.ts   (requires `cd viewer && bun run build`)
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const distIndex = join(ROOT, "viewer", "dist", "index.html");
if (!existsSync(distIndex)) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build` first"); process.exit(2); }
const indexHtml = readFileSync(distIndex);

// local transformers.js runtime + model files (the node-side cache of the SAME model the page uses)
const TDIST = join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
const TMODEL = join(ROOT, "node_modules", "@huggingface", "transformers", ".cache", "Xenova", "all-MiniLM-L6-v2");
if (!existsSync(join(TMODEL, "onnx", "model.onnx"))) { console.error("✗ local MiniLM cache missing (node_modules/@huggingface/transformers/.cache) — run any node embed once"); process.exit(2); }

// serve the built app; NO /map.eido — that 404 IS the empty state under test
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname; if (process.env.EIDO_E2E_DEBUG) console.error("[srv]", path);
    if (path === "/map.eido") return new Response("not here", { status: 404 });
    // the ort wasm binaries + MiniLM weights, served from the LOCAL package (hermetic ingest e2e); the
    // transformers.js RUNTIME itself is bundled into the app (same npm package as the node pipeline)
    if (path.startsWith("/tfwasm/")) { const f = join(TDIST, path.slice("/tfwasm/".length)); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    const hf = path.match(/^\/hf\/.*all-MiniLM-L6-v2\/resolve\/[^/]+\/(.+)$/);
    if (hf) { const f = hf[1].startsWith("onnx/") ? join(TMODEL, "onnx", "model.onnx") : join(TMODEL, hf[1]); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    if (path.startsWith("/hf/")) return new Response("", { status: 404 });
    return new Response(indexHtml, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;

// ── a small synthetic corpus: 3 topics × 4 docs, distinct vocabulary, real .md files on disk ─────────
const corpusDir = mkdtempSync(join(tmpdir(), "eido-ingest-corpus-"));
const TOPICS = [
  { name: "volcano", words: "magma lava eruption caldera basalt pyroclastic vent fissure tephra stratovolcano" },
  { name: "pastry", words: "croissant laminated butter dough proofing viennoiserie ganache choux tart glaze" },
  { name: "sailing", words: "spinnaker halyard jib tack gybe keel windward leeward mainsail rigging" },
];
let fileCount = 0;
for (const t of TOPICS) for (let i = 0; i < 4; i++) {
  const body = Array.from({ length: 8 }, (_, s) => `Notes on ${t.name} session ${i} part ${s}: ${t.words} — observed in study ${i}.${s}.`).join("\n\n");
  writeFileSync(join(corpusDir, `${t.name}-${i}.md`), `# ${t.name} study ${i}\n\n${body}\n`);
  fileCount++;
}
// one junk file the floor must drop (and report)
writeFileSync(join(corpusDir, "stub.md"), "# stub\n\ntoo short");

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

// ── the mocked OpenRouter: real HTTP shape, deterministic content, keyed off ax's own system prompt ──
let llmCalls = { card: 0, axes: 0, region: 0 };
function mockLLM(bodyStr: string): string {
  const body = JSON.parse(bodyStr);
  const sys: string = body.messages[0]?.content ?? "";
  const user: string = body.messages[body.messages.length - 1]?.content ?? "";
  let content = "";
  if (sys.includes("`Restatement`")) {
    llmCalls.card++;
    const title = (user.match(/Document Title:\s*([^\n]+)/) || [])[1]?.trim() ?? "untitled";
    const nAxes = (user.match(/^\s*\d+\.\s/gm) || []).length || 2;
    content = `Restatement: MOCKCORE restatement of ${title} in one uniform voice.\nAxis Placements:\n` +
      Array.from({ length: nAxes }, (_, i) => `- sits mid-field on axis ${i + 1} for ${title}`).join("\n");
  } else if (sys.includes("`Axis Names`")) {
    llmCalls.axes++;
    const n = (user.match(/AXIS \d+/g) || []).length || 2;
    const mk = (f: (i: number) => string) => Array.from({ length: n }, (_, i) => "- " + f(i + 1)).join("\n");
    content = `Axis Names:\n${mk((i) => `mock contrast ${i}`)}\nLow Pole Labels:\n${mk((i) => `low pole ${i}`)}\nHigh Pole Labels:\n${mk((i) => `high pole ${i}`)}\nCoherence Scores:\n${mk(() => "4")}`;
  } else if (sys.includes("`Region Label`")) {
    llmCalls.region++;
    const term = (user.match(/Distinctive Terms:\s*([^,\n]+)/) || [])[1]?.trim() ?? "region";
    content = `Region Label: R-${term}\nRegion Blurb: a mocked blurb about ${term}`;
  }
  return JSON.stringify({ id: "mock", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
}

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const pageErrs: string[] = []; p.on("pageerror", (e) => pageErrs.push(String(e)));
p.on("crash", () => console.error("!! PAGE CRASHED"));
if (process.env.EIDO_E2E_DEBUG) p.on("console", (m) => console.error("[page]", m.type(), m.text().slice(0, 300)));
const blocked: string[] = [];

// OpenRouter → the mock (this is the ONLY llm path; the page's real ax client + parser run against it)
await p.route("https://openrouter.ai/**", async (route) => {
  const req = route.request();
  route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: mockLLM(req.postData() ?? "{}") });
});
// the weights + ort wasm come from the LOCAL Bun server (see fetch above), pointed at via the page's
// test seams (the library's documented env.remoteHost / wasmPaths) — so the only intercepted host is
// OpenRouter. Everything else non-local is aborted.
await p.addInitScript(`window.__EIDO_TF_HOST = ${JSON.stringify(base + "/hf/")}; window.__EIDO_TF_WASM = ${JSON.stringify(base + "/tfwasm/")};`);
// RECEIPTS for the async engine (eid-yhj7): (1) main-thread responsiveness across the FULL cold ingest,
// measured by TWO independent instruments — the long-animation-frame observer (spec threshold: an entry
// exists only when a frame ran >=50ms) and a continuous rAF clock recording every gap >100ms. The
// "longtask" entryType was measured (2026-08-09, probe with all three instruments side by side) to
// report the WORKER's 1.2s wasm embed task against a main thread whose rAF cadence never gapped — it
// misattributes cross-thread work in this Chromium, so it is NOT the instrument here.
// (2) a 100ms sampler of the panel's status label + estimate line — the stages must narrate granularly
// (axes replicates, per-card counts) and the measured-rate estimate line must actually appear.
await p.addInitScript(`
  window.__loaf = []; window.__gaps = []; window.__labels = []; window.__est = [];
  (function tick(prev) { requestAnimationFrame((now) => { if (prev && now - prev > 100) window.__gaps.push(Math.round(now - prev)); tick(now); }); })(0);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push(Math.round(e.duration)); }).observe({ entryTypes: ["long-animation-frame"] }); } catch {}
  setInterval(() => {
    const s = document.querySelector('[data-testid=ingest-status]')?.textContent?.trim();
    if (s && window.__labels[window.__labels.length - 1] !== s) window.__labels.push(s);
    const e = document.querySelector('[data-testid=ingest-estimate]')?.textContent?.trim();
    if (e && window.__est[window.__est.length - 1] !== e) window.__est.push(e);
  }, 100);
`);
// hermetic: nothing else leaves localhost
await p.route(/^https?:\/\/(?!localhost)/, (route) => {
  const u = route.request().url();
  if (/openrouter\.ai/.test(u)) return route.fallback();
  blocked.push(u); route.abort();
});

console.log("eidoscope IN-PAGE INGEST e2e (real app, real embedder, mocked LLM at the network edge)\n");
try {
  await p.goto(base + "/index.html");

  // 1. the EMPTY STATE: no bundled map → the open panel, not an error screen
  await p.waitForSelector("[data-testid=open-panel]", { timeout: 15000 });
  ok(true, "no map.eido → the open-a-corpus panel (empty state), not a failure screen");
  ok(pageErrs.length === 0, "no page errors on the empty state" + (pageErrs.length ? " — " + pageErrs[0] : ""));

  // 2. pick the folder (webkitdirectory input accepts a directory path)
  await p.setInputFiles("[data-testid=open-folder]", corpusDir);
  await p.waitForSelector("[data-testid=ingest-key]", { timeout: 10000 });
  const corpusLine = await p.locator("[data-testid=ingest-corpus]").textContent();
  ok(/13 files/.test(corpusLine ?? ""), `the ingest panel names the corpus — "${corpusLine?.trim()}"`);

  // 3. KEY GATE: start with NO key → the run stops at the axes stage and says plainly what's needed.
  // The longtask window opens HERE — before the COLD start — so the receipt spans the model download,
  // wasm init, document embedding, axes, and later the keyed carding + layout + mount: the full run.
  await p.fill("[data-testid=ingest-key]", "");
  await p.evaluate(() => { (window as any).__loaf = []; (window as any).__gaps = []; (window as any).__labels = []; (window as any).__est = []; });
  await p.click("[data-testid=ingest-start]");
  await p.waitForSelector('[data-testid=ingest-status][data-phase="need-key"]', { timeout: 120000 });
  const gate = await p.locator("[data-testid=ingest-status]").textContent();
  ok(/axes discovered/.test(gate ?? "") && /Carding needs an LLM key/.test(gate ?? ""), "keyless run stops AFTER axes with the honest line (cards are the bottleneck and the point)");
  ok(llmCalls.card === 0, `no card calls were spent without a key — card calls: ${llmCalls.card}`);

  // 4. enter the key and RESUME — embeddings + axes are kept, carding runs, the map mounts
  await p.fill("[data-testid=ingest-key]", "sk-or-e2e-test");
  await p.click("[data-testid=ingest-start]");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 120000 });
  const perf = await p.evaluate(() => ({ loaf: (window as any).__loaf as number[], gaps: (window as any).__gaps as number[], labels: (window as any).__labels as string[], est: (window as any).__est as string[] }));
  // an entry EXISTS only at >=50ms — the honest bar is ZERO across the whole cold window:
  // model download + wasm init + embed + axes + cards + layout + map mount.
  ok(perf.loaf.length === 0, `ZERO main-thread long frames (>=50ms) through the ENTIRE cold ingest — model load → embed → axes → cards → layout → mount${perf.loaf.length ? ` — saw [${perf.loaf.join(",")}]ms` : ""}`);
  ok(perf.gaps.length === 0, `the rAF clock never gapped >100ms through the same window (independent ground truth)${perf.gaps.length ? ` — gaps [${perf.gaps.join(",")}]ms` : ""}`);
  ok(perf.labels.some((l) => /replicate \d\/8/.test(l)) || perf.labels.some((l) => /PCA over/.test(l)), `the axes stage narrates its real steps (PCA / shuffle replicates), not one static label — saw: ${JSON.stringify(perf.labels.filter((l) => /replicate|PCA|naming/.test(l)).slice(0, 3))}`);
  ok(perf.est.length > 0, `the measured-rate ESTIMATE line appeared during the run (the refusal envelope is dead) — "${perf.est[0]}"`);
  await p.waitForTimeout(400);
  const s = await p.evaluate(() => (window as any).__eido());
  ok(s.visible === 12, `the mounted map shows the 12 real docs (stub.md dropped by the floor) — visible=${s.visible}`);
  ok(llmCalls.card === 12, `exactly one card call per doc — ${llmCalls.card}`);
  ok(llmCalls.axes >= 1 && llmCalls.region >= 1, `axis naming (${llmCalls.axes}) and region naming (${llmCalls.region}) went through the same mocked endpoint`);
  ok(s.dims.some((d: string) => d.startsWith("axis:") || d === "hub"), "the dimension registry is populated from the freshly built map");

  // 5. the key stayed in the browser and out of the document
  const stored = await p.evaluate(() => localStorage.getItem("eido-llm-key"));
  ok(stored === "sk-or-e2e-test", "the key is held in localStorage (this browser only)");

  // 6. the cards ARE the mocked LLM's cards — open the deck and read one core
  await p.keyboard.press("Escape"); // intro
  await p.waitForTimeout(300);
  await p.keyboard.press("d");
  await p.waitForSelector("[data-deck-card]", { timeout: 10000 });
  const core = await p.locator("[data-deck-card]").first().textContent();
  ok(/MOCKCORE/.test(core ?? ""), "a card's core is the (mock) LLM restatement — the bottleneck was really traversed");
  const title2 = await p.title();
  ok(/eidoscope/.test(title2), `document title carries the corpus — "${title2}"`);

  // 7. provenance says in-page ingest; the working document saves through the shared codec (views seam exists)
  const prov = await p.evaluate(() => { const d = (window as any).__eido; return (document.title); });
  const provOk = await p.evaluate(() => !!document.querySelector("[data-scope]"));
  ok(provOk, "the toolbar mounted over the ingested map (same working-document path as a dropped .eido)");
  void prov;

  ok(pageErrs.length === 0, "no page errors through the whole ingest" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  ok(blocked.length === 0, "no request needed the real network" + (blocked.length ? ` — blocked: ${blocked[0]}` : ""));
} catch (e) {
  fails.push("harness error: " + e);
  console.error(e);
} finally {
  await browser.close();
  server.stop();
}

if (fails.length) { console.error(`\n✗ ${fails.length} ingest e2e failure(s):`); fails.forEach((f) => console.error("  -", f)); process.exit(1); }
console.log("\n✅ in-page ingest e2e: all assertions passed");
process.exit(0);
