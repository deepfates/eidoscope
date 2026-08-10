// The UNFAKED smoke (promise of 2026-08-10): a real browser, the real built app, a real (tiny)
// corpus, the real LLM over the real network — no mocks anywhere. Green here means reality ran.
// Costs ~a cent. Runs when a key is present (OPENROUTER_API_KEY / .env); prints SKIP without one —
// CI without secrets skips loudly, never silently passes.
// Usage: bun bin/real-smoke.ts    (expects viewer/dist built; `cd viewer && bun run build` first)
import { chromium } from "playwright";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const KEY = process.env.OPENROUTER_API_KEY ?? "";
if (!KEY) { console.log("SKIP real-smoke: no OPENROUTER_API_KEY in env (.env is auto-loaded by bun)"); process.exit(0); }
const dist = join(ROOT, "viewer/dist/index.html");
if (!existsSync(dist)) { console.error("✗ viewer/dist missing — run `cd viewer && bun run build`"); process.exit(2); }

// a tiny real corpus: the bundled example docs (12 short files → a few dozen LLM calls total)
const CORPUS = join(ROOT, "example");

const srv = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/" || p === "/index.html") return new Response(Bun.file(dist));
  return new Response("x", { status: 404 });
} });
const b = await chromium.launch();
const p = await b.newPage();
const t0 = Date.now();
try {
  await p.goto(`http://localhost:${srv.port}/`);
  await p.waitForTimeout(2000);
  await p.locator("input[webkitdirectory]").setInputFiles(CORPUS);
  // key gate appears after axes (or immediately if remembered) — fill it whenever it shows
  const deadline = Date.now() + 8 * 60_000;
  let mounted = 0;
  while (Date.now() < deadline && !mounted) {
    const key = p.locator("input[type=password]").first();
    if ((await key.count()) && (await key.isVisible().catch(() => false)) && !(await key.inputValue().catch(() => "x"))) {
      await key.fill(KEY); await key.press("Enter").catch(() => {});
    }
    mounted = await p.evaluate(() => { try { return (window as any).__eido?.()?.regions ?? 0; } catch { return 0; } });
    if (!mounted) await p.waitForTimeout(4000);
  }
  const st = await p.evaluate(() => (window as any).__eido?.() ?? null);
  const mins = Math.round((Date.now() - t0) / 6000) / 10;
  if (!st?.regions || !st?.visible) { console.error(`✗ real-smoke: no map mounted after ${mins}min`); process.exit(1); }
  console.log(`✅ real-smoke: ${st.visible} cards · ${st.regions} regions · ${mins}min · real key, real calls, no mocks`);
} finally { await b.close(); srv.stop(); }
