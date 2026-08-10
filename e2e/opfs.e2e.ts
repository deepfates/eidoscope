// E2E for OPFS CACHE PERSISTENCE (eid-yhj7): prove that closing the tab mid-way no longer loses paid
// work — ingest a synthetic corpus, RELOAD the page (new document, same origin storage), re-ingest the
// SAME folder, and count what the second pass spends. The receipts are network-edge counts, not vibes:
// zero card calls, zero model-weight fetches (the fully-cached embed pass never loads the extractor),
// and the second run is order-of-magnitude faster. Same hermetic rig as ingest.e2e.ts: real app, real
// embedder served locally, LLM mocked at the OpenRouter edge (the caches are what's under test).
// Run: bun run e2e/opfs.e2e.ts   (requires `cd viewer && bun run build`)
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const distIndex = join(ROOT, "viewer", "dist", "index.html");
if (!existsSync(distIndex)) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build` first"); process.exit(2); }
const indexHtml = readFileSync(distIndex);

const TDIST = join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
const TMODEL = join(ROOT, "node_modules", "@huggingface", "transformers", ".cache", "Xenova", "all-MiniLM-L6-v2");
if (!existsSync(join(TMODEL, "onnx", "model.onnx"))) { console.error("✗ local MiniLM cache missing — run any node embed once"); process.exit(2); }

let hfRequests = 0;   // model-weight fetches: the second pass must make NONE
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/map.eido") return new Response("not here", { status: 404 });
    if (path === "/tf") return new Response(Bun.file(join(TDIST, "transformers.min.js")), { headers: { "content-type": "text/javascript" } });
    if (path.startsWith("/tf/dist/")) { const f = join(TDIST, path.slice("/tf/dist/".length)); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    if (path.startsWith("/tfwasm/")) { const f = join(TDIST, path.slice("/tfwasm/".length)); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    const hf = path.match(/^\/hf\/.*all-MiniLM-L6-v2\/resolve\/[^/]+\/(.+)$/);
    if (hf) { hfRequests++; const f = hf[1].startsWith("onnx/") ? join(TMODEL, "onnx", "model.onnx") : join(TMODEL, hf[1]); return existsSync(f) ? new Response(Bun.file(f)) : new Response("", { status: 404 }); }
    if (path.startsWith("/hf/")) return new Response("", { status: 404 });
    return new Response(indexHtml, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;

// same 3-topics×4-docs synthetic corpus as ingest.e2e.ts
const corpusDir = mkdtempSync(join(tmpdir(), "eido-opfs-corpus-"));
const TOPICS = [
  { name: "volcano", words: "magma lava eruption caldera basalt pyroclastic vent fissure tephra stratovolcano" },
  { name: "pastry", words: "croissant laminated butter dough proofing viennoiserie ganache choux tart glaze" },
  { name: "sailing", words: "spinnaker halyard jib tack gybe keel windward leeward mainsail rigging" },
];
for (const t of TOPICS) for (let i = 0; i < 4; i++) {
  const body = Array.from({ length: 8 }, (_, s) => `Notes on ${t.name} session ${i} part ${s}: ${t.words} — observed in study ${i}.${s}.`).join("\n\n");
  writeFileSync(join(corpusDir, `${t.name}-${i}.md`), `# ${t.name} study ${i}\n\n${body}\n`);
}

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

// mocked OpenRouter (same shapes as ingest.e2e.ts) with per-kind counters — the receipt
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
if (process.env.EIDO_E2E_DEBUG) p.on("console", (m) => console.error("[page]", m.type(), m.text().slice(0, 300)));
const blocked: string[] = [];
await p.route("https://openrouter.ai/**", async (route) => {
  route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: mockLLM(route.request().postData() ?? "{}") });
});
await p.addInitScript(`window.__EIDO_TF_HOST = ${JSON.stringify(base + "/hf/")}; window.__EIDO_TF_WASM = ${JSON.stringify(base + "/tfwasm/")};`);
await p.route(/^https?:\/\/(?!localhost)/, (route) => {
  const u = route.request().url();
  if (/openrouter\.ai/.test(u)) return route.fallback();
  blocked.push(u); route.abort();
});

// one full ingest of the folder in the CURRENT page; returns wall time to the mounted map
async function ingestOnce(): Promise<number> {
  await p.waitForSelector("[data-testid=open-panel]", { timeout: 15000 });
  await p.setInputFiles("[data-testid=open-folder]", corpusDir);
  await p.waitForSelector("[data-testid=ingest-key]", { timeout: 10000 });
  await p.fill("[data-testid=ingest-key]", "sk-or-e2e-test");
  const t0 = Date.now();
  await p.click("[data-testid=ingest-start]");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 180000 });
  return Date.now() - t0;
}

console.log("eidoscope OPFS CACHE e2e (ingest → reload the page → re-ingest the same folder)\n");
try {
  await p.goto(base + "/index.html");
  const hasOPFS = await p.evaluate(async () => {
    const nav: any = navigator;
    if (!nav?.storage?.getDirectory) return false;
    const root = await nav.storage.getDirectory();
    const fh: any = await root.getFileHandle("probe.txt", { create: true });
    return typeof fh.createWritable === "function";
  });
  ok(hasOPFS, "this browser has OPFS with main-thread createWritable (Chromium — the persistence path is live)");

  // ── PASS 1: cold — everything is spent once ──────────────────────────────────────────────────────
  const t1 = await ingestOnce();
  ok(llmCalls.card === 12, `cold pass spends exactly one card call per doc — ${llmCalls.card}/12`);
  const hfPass1 = hfRequests;
  ok(hfPass1 > 0, `cold pass fetched the embedding model (${hfPass1} weight/config requests)`);
  console.log(`  · cold ingest wall time: ${t1}ms`);
  await p.waitForTimeout(600);   // let the last append flush (writes commit on close, chained in ms)

  // the cache files are really in OPFS, as jsonl the node side would recognize
  const files = await p.evaluate(async () => {
    const root = await (navigator as any).storage.getDirectory();
    const dir = await root.getDirectoryHandle("eido-cache");
    const out: Record<string, number> = {};
    for await (const [name, h] of (dir as any).entries()) if (h.kind === "file") out[name] = (await h.getFile()).size;
    return out;
  });
  const names = Object.keys(files);
  ok(names.some((n) => n.startsWith("cards")) && names.some((n) => n.startsWith("emb")) && names.some((n) => n.startsWith("regions")),
    `OPFS holds the three cache files — ${names.map((n) => `${n} (${files[n]}b)`).join(", ")}`);
  ok(names.filter((n) => n.startsWith("emb")).every((n) => /all-MiniLM-L6-v2/.test(n)), "the embedding cache file is keyed by model id (content+model addressing)");

  // ── RELOAD: a fresh document — session memory is gone, OPFS is not ───────────────────────────────
  await p.reload();

  // ── PASS 2: warm — zero card calls, zero weight fetches, embedding instant ───────────────────────
  const cardsBefore = llmCalls.card;
  const t2 = await ingestOnce();
  ok(llmCalls.card === cardsBefore, `ZERO card calls on the re-ingest after reload — still ${llmCalls.card} total`);
  ok(hfRequests === hfPass1, `ZERO model-weight fetches on the re-ingest (fully cached embed pass never loads the extractor) — still ${hfRequests} total`);
  console.log(`  · warm ingest wall time: ${t2}ms (cold was ${t1}ms)`);
  ok(t2 < t1 / 2, `the warm pass is at least 2× faster — ${t2}ms vs ${t1}ms`);
  const s = await p.evaluate(() => (window as any).__eido());
  ok(s.visible === 12, `the warm map is the same 12-card map — visible=${s.visible}`);

  ok(pageErrs.length === 0, "no page errors across both passes" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  ok(blocked.length === 0, "no request needed the real network" + (blocked.length ? ` — blocked: ${blocked[0]}` : ""));
} catch (e) {
  fails.push("harness error: " + e);
  console.error(e);
} finally {
  await browser.close();
  server.stop();
}

if (fails.length) { console.error(`\n✗ ${fails.length} opfs e2e failure(s):`); fails.forEach((f) => console.error("  -", f)); process.exit(1); }
console.log("\n✅ opfs cache e2e: all assertions passed");
process.exit(0);
