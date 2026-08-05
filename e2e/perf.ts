// Ground-truth frame cadence for the viewer at scale — measures TRUE paint intervals (rAF deltas: if the
// main thread blocks, no rAF fires, so the next delta captures the stall). Reports median/p95/max/jank%
// for (A) the mde->axes layout transition and (B) steady-state pan/zoom, on the biggest corpus present.
// Run: bun run e2e/perf.ts   Verifies (not imagines) whether eid-9sba's "13k transition freeze" is real.
import { chromium, type Page } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dist = join(import.meta.dir, "..", "viewer", "dist");
const hasPf = existsSync(join(dist, "pathfinder.eido"));
const map = hasPf ? "pathfinder.eido" : "map.eido";
const server = Bun.serve({ port: 0, fetch(req) {
  const f = new URL(req.url).pathname.replace(/^\//, "") || "index.html";
  const ct = f.endsWith(".eido") ? "application/octet-stream" : "text/html";
  try { return new Response(readFileSync(join(dist, f)), { headers: { "content-type": ct } }); } catch { return new Response(readFileSync(join(dist, "index.html")), { headers: { "content-type": "text/html" } }); }
} });
const base = `http://localhost:${server.port}`;
const setControl = (p: Page, label: string, value: string) => p.evaluate(([label, value]) => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === label); const s = l?.querySelector("select") as HTMLSelectElement | undefined; if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); }, [label, value] as [string, string]);

const startRec = (p: Page) => p.evaluate(() => { (window as any).__f = []; let last = performance.now(); const rec = () => { const t = performance.now(); (window as any).__f.push(t - last); last = t; (window as any).__raf = requestAnimationFrame(rec); }; last = performance.now(); rec(); });
const stopRead = (p: Page) => p.evaluate(() => { cancelAnimationFrame((window as any).__raf); const f: number[] = (window as any).__f.slice(1); return f; });
const stats = (f: number[]) => { const s = [...f].sort((a, b) => a - b); const pct = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0; const jank = f.filter((d) => d > 50).length; return { frames: f.length, median: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +Math.max(0, ...f).toFixed(1), jankOver50ms: jank, jankPct: +((100 * jank) / (f.length || 1)).toFixed(1) }; };

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs: string[] = []; p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.addInitScript(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });
await p.goto(`${base}/index.html?map=${map}`);
await p.waitForFunction(() => ((window as any).__eido?.()?.regions ?? 0) > 0, null, { timeout: 20000 });
const n = await p.evaluate(() => (window as any).__eido().k && document.title, );
await p.waitForTimeout(2500);
console.log(`corpus: ${map} · measuring true rAF frame intervals\n`);

// A) layout transition mde -> axes
await startRec(p);
await setControl(p, "layout", "axes");
await p.waitForTimeout(1500);
const A = stats(await stopRead(p));
console.log("A) mde->axes transition:", JSON.stringify(A));

await setControl(p, "layout", "mde"); await p.waitForTimeout(800);
// B1) pure wheel-zoom (no pointer move → no hover/picking)
await p.mouse.move(640, 400); await p.waitForTimeout(100);
await startRec(p);
for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, i % 2 ? -120 : 120); await p.waitForTimeout(40); }
const B1 = stats(await stopRead(p));
console.log("B1) zoom only (wheel):", JSON.stringify(B1));
// B2) pure pointer move over the cloud (fires onHover → deck picking readback on 13k pts + autoHighlight)
await p.waitForTimeout(400);
await startRec(p);
for (let i = 0; i < 30; i++) { await p.mouse.move(500 + (i % 15) * 12, 350 + (i % 7) * 14); await p.waitForTimeout(25); }
const B2 = stats(await stopRead(p));
console.log("B2) hover/pick (pointer move):", JSON.stringify(B2));

console.log(`\ninterpretation: median≈16ms = 60fps; p95/max show worst stalls; jankOver50ms = frames slower than ~20fps.`);
console.log(errs.length ? `console errors: ${errs.slice(0, 3).join(" | ")}` : "no console errors");
await browser.close(); server.stop();
