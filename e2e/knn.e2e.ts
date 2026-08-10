// E2E for the kNN regimes IN A REAL BROWSER (see e2e/knn.probe.ts for what runs in the page): the
// page seam must feature-detect WebGPU and answer EXACTLY above HNSW_MIN; the vendored hnswlib wasm
// must clear 0.99 recall; and a full in-page engine run (real buildMap, mock LLM, n past HNSW_MIN)
// must emit nbr lists that match exact truth over its own card vectors — the honest-neighbors receipt.
// Run: bun run e2e/knn.e2e.ts
import { chromium } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const outDir = mkdtempSync(join(tmpdir(), "eido-knn-e2e-"));
const build = Bun.spawnSync(["bun", "build", join(ROOT, "e2e", "knn.probe.ts"), "--target=browser", "--outfile", join(outDir, "probe.js")], { cwd: ROOT });
if (build.exitCode !== 0) { console.error("✗ probe bundle failed:\n" + build.stderr.toString()); process.exit(2); }

const html = `<!doctype html><html><body><script type="module" src="/probe.js"></script></body></html>`;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/probe.js") return new Response(readFileSync(join(outDir, "probe.js")), { headers: { "content-type": "text/javascript" } });
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

console.log("eidoscope kNN-regimes e2e (real Chromium, WebGPU enabled)\n");
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu", "--use-angle=metal"] });
try {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => fails.push("pageerror: " + e.message));
  await p.goto(`http://localhost:${server.port}/`);
  await p.waitForFunction("window.__ready === true", null, { timeout: 20000 });
  p.setDefaultTimeout(0);
  const r: any = await p.evaluate("window.runKnnProbe()", { timeout: 0 } as any);
  console.log("  probe:", JSON.stringify(r));

  if (!r.gpuSupported) console.warn("  ⚠ this Chromium exposes no WebGPU — exact-gpu receipts degrade to exact-cpu");
  const wantMethod = r.gpuSupported ? "exact-gpu" : "exact-cpu";
  ok(r.seamMethod === wantMethod, `above HNSW_MIN the page seam answered with ${wantMethod} (got ${r.seamMethod})`);
  ok(r.seamBadRows === 0, `seam neighbors ≡ exact truth up to f32 ties (${r.seamBadRows} bad rows, recall ${r.seamRecall})`);
  ok(r.wasmRecall >= 0.99, `vendored hnswlib wasm recall ${r.wasmRecall} ≥ 0.99 at eidoscope params (${r.wasmMs}ms @ 6000)`);
  ok(r.neighborsProvenance === wantMethod, `the emitted map's derivedBy.neighbors says which regime built it ("${r.neighborsProvenance}")`);
  ok(r.engineNbrBadRows === 0, `end-to-end in-page engine: emitted nbr ≡ exact truth over the card vectors (${r.engineNbrBadRows} bad rows, recall ${r.engineNbrRecall}, engine ${r.engineMs}ms)`);
} catch (e) {
  fails.push("harness error: " + e);
  console.error(e);
} finally {
  await browser.close();
  server.stop();
  rmSync(outDir, { recursive: true, force: true });
}

if (fails.length) { console.error(`\n✗ ${fails.length} knn e2e failure(s):`); fails.forEach((f) => console.error("  -", f)); process.exit(1); }
console.log("\n✅ knn regimes e2e: all assertions passed");
process.exit(0);
