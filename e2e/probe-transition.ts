// Measure (not eyeball) the camera during a layout switch: poll __eido().zoom every ~16ms while flipping
// mde→axes, and print the zoom timeline. A single big step at the switch = a jarring pre-jump; a smooth
// ramp over ~700ms = the camera easing with the points. Run: bun run e2e/probe-transition.ts
import { chromium, type Page } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dist = join(import.meta.dir, "..", "viewer", "dist");
const hasPf = existsSync(join(dist, "pathfinder.eido"));
const server = Bun.serve({ port: 0, fetch(req) {
  const f = new URL(req.url).pathname.replace(/^\//, "") || "index.html";
  const ct = f.endsWith(".eido") ? "application/octet-stream" : "text/html";
  try { return new Response(readFileSync(join(dist, f)), { headers: { "content-type": ct } }); } catch { return new Response(readFileSync(join(dist, "index.html")), { headers: { "content-type": "text/html" } }); }
} });
const base = `http://localhost:${server.port}`;
const setControl = (page: Page, label: string, value: string) => page.evaluate(([label, value]) => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === label); const s = l?.querySelector("select") as HTMLSelectElement | undefined; if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); }, [label, value] as [string, string]);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });
await p.goto(`${base}/index.html?map=map.eido`);
await p.waitForFunction(() => ((window as any).__eido?.()?.regions ?? 0) > 0, null, { timeout: 20000 });
await p.waitForTimeout(2000);

// start a high-frequency sampler in-page that records {t, zoom, layout} into an array
await p.evaluate(() => { (window as any).__samples = []; const tick = () => { const e = (window as any).__eido(); (window as any).__samples.push({ t: performance.now(), zoom: +e.zoom.toFixed(4), layout: e.layout }); (window as any).__raf = requestAnimationFrame(tick); }; tick(); });
await p.waitForTimeout(150);
const t0 = await p.evaluate(() => { (window as any).__switchT = performance.now(); return (window as any).__switchT; });
await setControl(p, "layout", process.env.TO || "axes");
await p.waitForTimeout(1200);
await p.evaluate(() => cancelAnimationFrame((window as any).__raf));
const { samples, switchT } = await p.evaluate(() => ({ samples: (window as any).__samples, switchT: (window as any).__switchT }));

// print zoom vs ms-since-switch, and flag the biggest single-step jump
let prev: any = null, maxStep = 0, maxAt = 0;
console.log(" ms    zoom    layout   Δzoom");
for (const s of samples) {
  const rel = s.t - switchT;
  if (rel < -60 || rel > 1000) { prev = s; continue; }
  const d = prev ? s.zoom - prev.zoom : 0;
  if (Math.abs(d) > Math.abs(maxStep)) { maxStep = d; maxAt = rel; }
  console.log(`${rel.toFixed(0).padStart(5)}  ${s.zoom.toFixed(3).padStart(7)}  ${s.layout.padEnd(6)}  ${d >= 0 ? "+" : ""}${d.toFixed(3)}`);
  prev = s;
}
console.log(`\nbiggest single-frame Δzoom = ${maxStep.toFixed(3)} at ${maxAt.toFixed(0)}ms after switch`);
console.log(maxStep && Math.abs(maxStep) > 0.4 ? "→ looks like a PRE-JUMP (discontinuous camera)" : "→ camera moves in small steps (eased) or not at all");
await browser.close(); server.stop();
