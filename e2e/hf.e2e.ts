// E2E for the HUGGINGFACE CONNECTOR (eid-ilc5): drive a REAL dataset→map ingest through the actual
// built app in Chromium — paste an id, look it up, pick the text column, watch paged row-fetch
// progress, then the SAME ingest panel/engine the folder connector uses, to a mounted map. HERMETIC:
// the datasets-server API is mocked at the network edge (playwright route serving canned /splits,
// /first-rows and paginated /rows), the LLM is mocked at the OpenRouter edge, the embedder is the
// REAL transformers.js MiniLM served from local node_modules; everything else is aborted.
// Run: bun run e2e/hf.e2e.ts   (requires `cd viewer && bun run build`)
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const distIndex = join(ROOT, "viewer", "dist", "index.html");
if (!existsSync(distIndex)) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build` first"); process.exit(2); }
const indexHtml = readFileSync(distIndex);

const TDIST = join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
const TMODEL = join(ROOT, "node_modules", "@huggingface", "transformers", ".cache", "Xenova", "all-MiniLM-L6-v2");
if (!existsSync(join(TMODEL, "onnx", "model.onnx"))) { console.error("✗ local MiniLM cache missing — run any node embed once"); process.exit(2); }

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

// ── the canned dataset: 12 long rows (3 topics × 4) + 1 short row the 200-char floor must drop ──────
const DATASET = "eido/test-corpus";
// Each topic carries METADATA COLUMNS (eid-xmf0): a comma-multivalue genre, a categorical author and
// a float score — the acceptance case's shape (genre/author/score) at e2e scale. They must arrive as
// placeable dimensions on the mounted map, not be dropped with the row.
const TOPICS = [
  { name: "volcano", genre: "geology, fire", author: "kim", words: "magma lava eruption caldera basalt pyroclastic vent fissure tephra stratovolcano" },
  { name: "pastry", genre: "baking, butter", author: "lee", words: "croissant laminated butter dough proofing viennoiserie ganache choux tart glaze" },
  { name: "sailing", genre: "sea, wind", author: "ana", words: "spinnaker halyard jib tack gybe keel windward leeward mainsail rigging" },
];
type Row = { row_idx: number; row: Record<string, unknown>; truncated_cells: string[] };
const ROWS: Row[] = [];
let idx = 0;
for (const t of TOPICS) for (let i = 0; i < 4; i++) {
  const text = Array.from({ length: 8 }, (_, s) => `Notes on ${t.name} session ${i} part ${s}: ${t.words} — observed in study ${i}.${s}.`).join("\n\n");
  ROWS.push({ row_idx: idx++, row: { title: `${t.name} study ${i}`, text, label: TOPICS.indexOf(t), genre: t.genre, author: t.author, score: 5 + idx * 0.3 }, truncated_cells: [] });
}
ROWS.push({ row_idx: idx++, row: { title: "stub", text: "too short", label: 0, genre: "stub", author: "kim", score: 0.1 }, truncated_cells: [] });
const FEATURES = [
  { feature_idx: 0, name: "title", type: { dtype: "string", _type: "Value" } },
  { feature_idx: 1, name: "text", type: { dtype: "string", _type: "Value" } },
  { feature_idx: 2, name: "label", type: { names: ["a", "b", "c"], _type: "ClassLabel" } },
  { feature_idx: 3, name: "genre", type: { dtype: "string", _type: "Value" } },
  { feature_idx: 4, name: "author", type: { dtype: "string", _type: "Value" } },
  { feature_idx: 5, name: "score", type: { dtype: "float64", _type: "Value" } },
];
const PAGE = 5;                                   // small page → the /rows pagination is really exercised
let rowsCalls: { offset: number; length: number }[] = [];

function dsApi(url: URL): object | null {
  const dataset = url.searchParams.get("dataset") ?? "";
  if (url.pathname === "/splits") {
    if (dataset === "eido/huge" || dataset === DATASET)
      return { splits: [{ dataset, config: "default", split: "train" }] };
    return null;
  }
  if (url.pathname === "/first-rows")
    return { dataset, config: "default", split: "train", features: FEATURES, rows: ROWS.slice(0, 3), truncated: false };
  if (url.pathname === "/rows") {
    const offset = Number(url.searchParams.get("offset") ?? 0), length = Number(url.searchParams.get("length") ?? PAGE);
    const total = dataset === "eido/huge" ? 999_999 : ROWS.length;
    if (dataset === DATASET) rowsCalls.push({ offset, length });
    return { features: FEATURES, rows: ROWS.slice(offset, offset + length), num_rows_total: total, num_rows_per_page: PAGE, partial: false };
  }
  return null;
}

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

// mocked OpenRouter, same shapes as e2e/ingest.e2e.ts
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

await p.route("https://openrouter.ai/**", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: mockLLM(route.request().postData() ?? "{}") }));
// the datasets-server API, mocked at the edge — the page's REAL connector code runs against it
await p.route("https://datasets-server.huggingface.co/**", (route) => {
  const body = dsApi(new URL(route.request().url()));
  if (body) route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  else route.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "dataset not found (mock)" }) });
});
await p.addInitScript(`window.__EIDO_TF_HOST = ${JSON.stringify(base + "/hf/")}; window.__EIDO_TF_WASM = ${JSON.stringify(base + "/tfwasm/")}; localStorage.setItem("eido-llm-key", "sk-or-e2e-test");`);
await p.route(/^https?:\/\/(?!localhost)/, (route) => {
  const u = route.request().url();
  if (/openrouter\.ai|datasets-server\.huggingface\.co/.test(u)) return route.fallback();
  blocked.push(u); route.abort();
});

console.log("eidoscope HF-CONNECTOR e2e (real app, real embedder, datasets-server + LLM mocked at the edge)\n");
try {
  await p.goto(base + "/index.html");
  await p.waitForSelector("[data-testid=open-panel]", { timeout: 15000 });

  // 1. the connector is on the front door
  await p.click("[data-testid=open-hf]");
  await p.waitForSelector("[data-testid=hf-id]", { timeout: 5000 });
  ok(true, "the empty state offers the HuggingFace connector; its dialog opens");

  // 2. a bad id is refused with the API's own error, not a crash
  await p.fill("[data-testid=hf-id]", "nobody/no-such-dataset");
  await p.click("[data-testid=hf-lookup]");
  await p.waitForSelector("[data-testid=hf-error]", { timeout: 10000 });
  const err = await p.locator("[data-testid=hf-error]").textContent();
  ok(/not found/.test(err ?? ""), `unknown dataset → the server's error, said plainly — "${err?.trim()}"`);

  // 3. a split past the in-page envelope is refused BEFORE any rows are downloaded
  await p.fill("[data-testid=hf-id]", "eido/huge");
  await p.click("[data-testid=hf-lookup]");
  await p.waitForSelector("[data-testid=hf-envelope]", { timeout: 10000 });
  ok((await p.locator("[data-testid=hf-ingest]").count()) === 0, "999,999 rows → the envelope line up front, no ingest button, nothing fetched");
  ok(rowsCalls.length === 0, "no row pages were pulled for the over-envelope dataset");
  await p.click("[data-testid=hf-relookup]");

  // 4. paste a URL (not a bare id) → lookup → columns offered → pick the text column
  await p.fill("[data-testid=hf-id]", `https://huggingface.co/datasets/${DATASET}`);
  await p.click("[data-testid=hf-lookup]");
  await p.waitForSelector("[data-testid=hf-preview]", { timeout: 10000 });
  const prev = await p.locator("[data-testid=hf-preview]").textContent();
  ok(new RegExp(`${DATASET} · default/train · 13 rows`).test(prev ?? ""), `the preview names the dataset and its honest row count — "${prev?.trim()}"`);
  const options = await p.locator("[data-testid=hf-column] option").allTextContents();
  ok(options.join(",") === "title,text,genre,author", `only string columns are offered as the text column — [${options.join(", ")}]`);
  await p.selectOption("[data-testid=hf-column]", "text");
  const sample = await p.locator("[data-testid=hf-sample]").textContent();
  ok(/volcano session 0/.test(sample ?? ""), "the chosen column previews a real sample row");

  // 5. ingest: rows page in (13 rows / 5 per page = 3 calls), then the SAME ingest panel runs to a map
  await p.click("[data-testid=hf-ingest]");
  await p.waitForSelector("[data-testid=ingest-corpus]", { timeout: 15000 });
  const corpusLine = await p.locator("[data-testid=ingest-corpus]").textContent();
  ok(new RegExp(`${DATASET} · 13 files`).test(corpusLine ?? ""), `the shared ingest panel receives the connector's corpus — "${corpusLine?.trim()}"`);
  ok(rowsCalls.length >= 3, `rows were paged lazily (${rowsCalls.length} /rows calls of ${PAGE})`);
  await p.click("[data-testid=ingest-start]");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 180000 });
  await p.waitForTimeout(400);
  let s = await p.evaluate(() => (window as any).__eido());
  ok(s.visible === 12, `the mounted map shows the 12 real rows (the short row dropped by the floor) — visible=${s.visible}`);
  ok(llmCalls.card === 12, `exactly one card call per row — ${llmCalls.card}`);

  // 6. titles came from the dataset's title column, straight onto the deck
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  await p.keyboard.press("d");
  await p.waitForSelector("[data-deck-card]", { timeout: 10000 });
  const deck = await p.locator("[data-deck-card]").first().textContent();
  ok(/MOCKCORE/.test(deck ?? ""), "cards traversed the (mocked) bottleneck like any other corpus");
  const anyTitle = await p.evaluate(() => document.body.textContent?.includes("volcano study 0"));
  ok(!!anyTitle, "row titles come from the dataset's title column");

  // 7. METADATA COLUMNS (eid-xmf0): the non-text columns arrived as PLACEABLE dimensions.
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);   // close the deck from step 6
  //    genre (comma-multivalue → categorical multi), author (categorical), score (float → scalar).
  ok(["genre", "author", "score"].every((k) => s.dims.includes(k)), `genre/author/score are registered dimensions — dims=[${s.dims.join(",")}]`);
  // colour by genre — the comma-multivalue column drives the colour channel
  await p.click('[data-menu="bar:color"]'); await p.waitForTimeout(200);
  ok((await p.locator('[data-opt="bar:color:genre"]').count()) === 1, "the colour menu offers the genre column");
  await p.click('[data-opt="bar:color:genre"]'); await p.waitForTimeout(250);
  s = await p.evaluate(() => (window as any).__eido());
  ok(s.color === "genre", `colour places on genre — color=${s.color}`);
  // …and the multi value split on the comma: first genre token, not the raw "geology, fire" string
  const genreRow = p.locator('button[aria-label="isolate genre geology"]').first();
  ok((await genreRow.count()) === 1, 'the legend shows the SPLIT genre token ("geology"), not the raw comma string');
  // facet-isolate one genre value: 4 volcano docs remain visible
  await genreRow.click(); await p.waitForTimeout(300);
  s = await p.evaluate(() => (window as any).__eido());
  ok(s.facetPin != null && s.visible === 4, `facet-isolating genre=geology leaves the 4 volcano docs — facetPin=${JSON.stringify(s.facetPin)} visible=${s.visible}`);
  await genreRow.click(); await p.waitForTimeout(250);   // release
  // score: the float column is a scalar dimension the colour channel accepts too
  await p.click('[data-opt="bar:color:score"]'); await p.waitForTimeout(250);
  s = await p.evaluate(() => (window as any).__eido());
  ok(s.color === "score" && s.visible === 12, `the float score column colours the map as a scalar — color=${s.color} visible=${s.visible}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);

  ok(pageErrs.length === 0, "no page errors end to end" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  ok(blocked.length === 0, "hermetic — nothing needed the real network" + (blocked.length ? ` — blocked: ${blocked[0]}` : ""));
} catch (e) {
  fails.push("harness error: " + e);
  console.error(e);
} finally {
  await browser.close();
  server.stop();
}

if (fails.length) { console.error(`\n✗ ${fails.length} hf-connector e2e failure(s):`); fails.forEach((f) => console.error("  -", f)); process.exit(1); }
console.log("\n✅ hf-connector e2e: all assertions passed");
process.exit(0);
