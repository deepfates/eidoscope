// E2E for DESCEND AS A GESTURE (eid-kep3): drive the REAL built app in Chromium — load the synthetic
// map, circle a clump with a real pointer-drawn lasso, hit the selection pane's `descend` verb, and
// assert the child map mounts IN PAGE as the working document: its own local axes, descent provenance,
// and NO download event anywhere (the selection-JSON ferry is dead). Two passes:
//   A. NO key → the child opens unnamed-but-honest: PC axis names, deterministic term region labels,
//      zero LLM calls, zero errors.
//   B. key present → axis + region naming go through the (network-edge-mocked) OpenRouter endpoint.
// HERMETIC: playwright route interception mocks OpenRouter; everything else non-local is aborted.
// Run: bun run e2e/descend.e2e.ts   (requires `cd viewer && bun run build`)
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encodeMap } from "../src/mapbin.ts";
import { synthMap as synth } from "./synth.ts";

const distIndex = join(import.meta.dir, "..", "viewer", "dist", "index.html");
if (!existsSync(distIndex)) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build` first"); process.exit(2); }
const indexHtml = readFileSync(distIndex);
const eido = encodeMap(synth());   // 3 blobs × 30 cards, CARRIES card vectors (dim 8, blob structure)

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/map.eido") return new Response(eido, { headers: { "content-type": "application/octet-stream" } });
    return new Response(indexHtml, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

// the mocked OpenRouter — descend only NAMES (axes + regions); a card call here would be a bug
let llmCalls = { card: 0, axes: 0, region: 0 };
function mockLLM(bodyStr: string): string {
  const body = JSON.parse(bodyStr);
  const sys: string = body.messages[0]?.content ?? "";
  const user: string = body.messages[body.messages.length - 1]?.content ?? "";
  let content = "";
  if (sys.includes("`Restatement`")) { llmCalls.card++; content = "Restatement: should never happen — descend reuses cards."; }
  else if (sys.includes("`Axis Names`")) {
    llmCalls.axes++;
    const n = (user.match(/AXIS \d+/g) || []).length || 2;
    const mk = (f: (i: number) => string) => Array.from({ length: n }, (_, i) => "- " + f(i + 1)).join("\n");
    content = `Axis Names:\n${mk((i) => `local contrast ${i}`)}\nLow Pole Labels:\n${mk((i) => `low ${i}`)}\nHigh Pole Labels:\n${mk((i) => `high ${i}`)}\nCoherence Scores:\n${mk(() => "4")}`;
  } else if (sys.includes("`Region Label`")) {
    llmCalls.region++;
    const term = (user.match(/Distinctive Terms:\s*([^,\n]+)/) || [])[1]?.trim() ?? "region";
    content = `Region Label: R-${term}\nRegion Blurb: a mocked blurb about ${term}`;
  }
  return JSON.stringify({ id: "mock", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
}

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1960, height: 1050 }, deviceScaleFactor: 2 });
const pageErrs: string[] = []; p.on("pageerror", (e) => pageErrs.push(String(e)));
let downloads = 0; p.on("download", () => downloads++);   // the ferry is DEAD — descend must download nothing
const blocked: string[] = [];
// mockDelayMs stretches each LLM answer so pass B has a real window in which the descend is IN FLIGHT —
// the receipt that the engine worker leaves the page interactive is a camera gesture landed mid-run.
let mockDelayMs = 0;
await p.route("https://openrouter.ai/**", async (route) => {
  if (mockDelayMs) await new Promise((r) => setTimeout(r, mockDelayMs));
  route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: mockLLM(route.request().postData() ?? "{}") });
});
await p.route(/^https?:\/\/(?!localhost)/, (route) => {
  const u = route.request().url();
  if (/openrouter\.ai/.test(u)) return route.fallback();
  blocked.push(u); route.abort();
});

const st = () => p.evaluate(() => (window as any).__eido());
const proj = (xy: number[]) => p.evaluate((xy) => (window as any).__eidoProject(xy) as number[], xy);

// circle blob 1 (indices 30..59, centred at world [1.6, 1.1]) with a REAL pointer-drawn lasso
async function lassoBlob1() {
  await p.keyboard.press("s"); await p.waitForTimeout(150);
  const [bx, by] = await proj([1.6, 1.1]);
  const [ex] = await proj([2.0, 1.1]);
  const rad = Math.abs(ex - bx);
  await p.mouse.move(bx + rad, by);
  await p.mouse.down();
  for (let a = 1; a <= 36; a++) { const t = (a / 36) * Math.PI * 2; await p.mouse.move(bx + rad * Math.cos(t), by + rad * Math.sin(t)); }
  await p.mouse.up();
  await p.waitForTimeout(400);
}
async function freshMap() {
  await p.goto(base + "/index.html");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.keyboard.press("Escape"); await p.waitForTimeout(200);   // the intro, if shown
}

console.log("eidoscope DESCEND e2e (real app, real lasso gesture, LLM mocked at the network edge)\n");
try {
  // ═══ A. DESCEND WITHOUT A KEY — the child opens unnamed-but-honest ═══════════════════════════════
  await p.addInitScript(() => { try { localStorage.removeItem("eido-llm-key"); localStorage.setItem("eido-seen", "1"); } catch {} });
  await freshMap();
  const parent = await st();
  ok(parent.visible === 90, `the parent synth map mounts — 90 cards visible, got ${parent.visible}`);
  const parentDims: string[] = parent.dims;   // dimension keys include the axes' own keys (synth: a, b, …)

  await lassoBlob1();
  let s = await st();
  ok(s.selection === 30, `a pointer-drawn lasso holds blob 1 (30 cards) — got ${s.selection}`);
  ok((await p.locator('[data-testid="sel-descend"]').isDisabled()) === false, "the `descend` verb is LIVE on a held set (vectors present, no key required)");

  await p.click('[data-testid="sel-descend"]');
  // the child REPLACES the working document: 30 cards, fresh axes, selection reset
  await p.waitForFunction(() => (window as any).__eido?.()?.visible === 30, null, { timeout: 60000 });
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);   // the child's intro overlay
  s = await st();
  ok(s.visible === 30, `the child map is the working document — 30 cards, got ${s.visible}`);
  ok(s.selection === 0, "the selection did not survive into the child (per-corpus state reset)");
  const childAxes = s.dims.filter((d: string) => /^pc\d+$/.test(d));
  ok(childAxes.length >= 2, `the child has its OWN local axes, not the parent's — parent dims [${parentDims.join(",")}] → child axis keys [${childAxes.join(",")}]`);
  ok(!s.dims.includes("a") && !s.dims.includes("b"), "the parent's axes (a, b) are GONE from the child's registry");
  const title = await p.title();
  ok(/▸ descent \(30\)/.test(title), `provenance names the lineage — document title "${title}"`);
  await p.click('[data-menu="bar:about"]'); await p.waitForTimeout(250);
  const aboutSrc = await p.evaluate(() => document.querySelector("[data-about]")?.textContent ?? "");
  ok(/descend of "synth-corpus" — 30 of 90 cards/.test(aboutSrc), "the about pane states the descent source (parent · 30 of 90)");
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  ok(llmCalls.axes === 0 && llmCalls.region === 0 && llmCalls.card === 0, `keyless descend spent ZERO LLM calls — ${JSON.stringify(llmCalls)}`);
  ok(downloads === 0, "no download occurred — the selection-JSON ferry is dead");
  ok(pageErrs.length === 0, "no page errors through the keyless descend" + (pageErrs.length ? " — " + pageErrs[0] : ""));

  // ═══ B. DESCEND WITH A KEY — naming goes through the mocked network edge ═════════════════════════
  await p.addInitScript(() => { try { localStorage.setItem("eido-llm-key", "sk-or-e2e-test"); } catch {} });
  await freshMap();
  await lassoBlob1();
  // ═══ INTERACTIVITY RECEIPT (eid-yhj7): the descend runs in the engine WORKER, so the parent map must
  // stay drivable while it cooks — zoom the camera MID-DESCEND with a real wheel gesture and assert it
  // moved, while a longtask observer proves the main thread never blocked >200ms.
  mockDelayMs = 500;   // stretch naming calls: a real in-flight window (~seconds), same deterministic answers
  await p.evaluate(() => {
    (window as any).__lt = [];
    try { new PerformanceObserver((l: any) => { for (const e of l.getEntries()) (window as any).__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] }); } catch {}
  });
  await p.click('[data-testid="sel-descend"]');
  await p.waitForTimeout(250);   // the run is now in flight (axes naming is delayed 500ms)
  const zoom0 = (await st()).zoom;
  const [cx, cy] = await proj([1.6, 1.1]);
  await p.mouse.move(cx, cy);
  await p.mouse.wheel(0, -400); await p.waitForTimeout(250);
  const midRun = await st();
  ok(midRun.visible === 90, "mid-descend the PARENT map is still the working document (the run cooks in the worker)");
  ok(midRun.zoom !== zoom0, `the camera answered a real wheel gesture MID-DESCEND — zoom ${zoom0} → ${midRun.zoom}`);
  await p.waitForFunction(() => (window as any).__eido?.()?.visible === 30, null, { timeout: 60000 });
  const lt = await p.evaluate(() => (window as any).__lt as number[]);
  const maxLT = lt.length ? Math.max(...lt) : 0;
  ok(maxLT < 200, `no main-thread long task through the whole keyed descend — ${lt.length} longtask(s), max ${maxLT}ms (< 200ms)`);
  mockDelayMs = 0;
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);   // the child's intro overlay
  s = await st();
  ok(llmCalls.axes >= 1, `axis naming went through the mocked endpoint — ${llmCalls.axes} call(s)`);
  ok(llmCalls.region >= 1, `region naming went through the mocked endpoint — ${llmCalls.region} call(s)`);
  ok(llmCalls.card === 0, "descend re-carded NOTHING — the cards are reused verbatim");
  const named = s.dims.filter((d: string) => /local.contrast.\d+/.test(d));
  ok(named.length >= 2, `with a key the local axes wear the (mock) LLM's names — dims [${s.dims.join(",")}]`);
  await p.click('[data-menu="bar:color"]'); await p.waitForTimeout(250);   // the colour popover IS the legend
  const legend = await p.evaluate(() => (document.querySelector(".eido-pop")?.textContent ?? "").trim());
  ok(/R-/.test(legend), `regions carry the (mock) LLM's labels — legend: "${legend.slice(0, 120)}"`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  ok(downloads === 0, "still no download — both descents stayed entirely in the page");
  ok(pageErrs.length === 0, "no page errors through the keyed descend" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  ok(blocked.length === 0, "no request needed the real network" + (blocked.length ? ` — blocked: ${blocked[0]}` : ""));
} catch (e) {
  fails.push("harness error: " + e);
  console.error(e);
} finally {
  await browser.close();
  server.stop();
}

if (fails.length) { console.error(`\n✗ ${fails.length} descend e2e failure(s):`); fails.forEach((f) => console.error("  -", f)); process.exit(1); }
console.log("\n✅ descend e2e: all assertions passed");
process.exit(0);
