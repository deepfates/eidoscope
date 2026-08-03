// Interaction-feel probe — the things static screenshots CAN'T show, driven live in Chromium and read from
// real state via window.__eido(). This is the honesty check for "does it actually work when you touch it."
// Run: cd viewer && bun run build   then   bun run e2e/interaction.ts
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "viewer", "dist");
if (!existsSync(join(dist, "index.html"))) { console.error("run `cd viewer && bun run build` first"); process.exit(2); }
const ctype = (f: string) => f.endsWith(".eido") ? "application/octet-stream" : "text/html";
const server = Bun.serve({ port: 0, fetch(req) { const f = new URL(req.url).pathname === "/" ? "index.html" : new URL(req.url).pathname.slice(1); try { return new Response(readFileSync(join(dist, f)), { headers: { "content-type": ctype(f) } }); } catch { return new Response(readFileSync(join(dist, "index.html")), { headers: { "content-type": "text/html" } }); } } });
const base = `http://localhost:${server.port}`;
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
await p.addInitScript(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });
const st = () => p.evaluate(() => (window as any).__eido());
const setLayout = (v: string) => p.evaluate((v) => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === "layout"); const s = l!.querySelector("select") as HTMLSelectElement; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, v); s.dispatchEvent(new Event("change", { bubbles: true })); }, v);

const out: string[] = [];
try {
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // 1) 3D ORBIT: does a drag actually rotate it?
  await setLayout("orbit"); await p.waitForTimeout(700);
  const rot0 = (await st()).rot;
  const cx = 640, cy = 400;
  await p.mouse.move(cx, cy); await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(cx + i * 18, cy + i * 6); await p.waitForTimeout(16); }
  await p.mouse.up(); await p.waitForTimeout(400);
  const rot1 = (await st()).rot;
  out.push(`orbit drag: rotationOrbit ${rot0} → ${rot1}  ${rot0 !== rot1 ? "✓ ROTATES" : "✗ NO ROTATION"}`);

  // 2) LAYOUT SMOOSH: switching layouts moves points — does the camera/zoom actually change state?
  await setLayout("mde"); await p.waitForTimeout(300);
  const a = await st();
  await setLayout("axes"); await p.waitForTimeout(900);
  const b = await st();
  out.push(`layout smoosh mde→axes: layout ${a.layout}→${b.layout}, zoom ${a.zoom.toFixed(2)}→${b.zoom.toFixed(2)}  ${a.layout !== b.layout ? "✓ switches" : "✗ stuck"}`);

  // 3) HOVER on desktop: does moving the mouse over the cloud set a hover?
  await setLayout("mde"); await p.waitForTimeout(500);
  let hovered = "none";
  for (const [dx, dy] of [[0, 0], [30, 20], [-40, 30], [60, -20], [-20, -40], [80, 40]]) {
    await p.mouse.move(640 + dx, 400 + dy); await p.waitForTimeout(120);
    const s = await st(); if (s.hover) { hovered = s.hover; break; }
  }
  out.push(`desktop hover over the cloud: ${hovered !== "none" ? "✓ fires (" + hovered + ")" : "✗ no hover fired in 6 probes"}`);

  // 4) COMBINATION: isolate a region, THEN change grain — does the stale pin clear cleanly?
  await p.evaluate(() => { const b = [...document.querySelectorAll('[role="button"][aria-label^="isolate region"]')][0] as HTMLElement; b?.click(); });
  await p.waitForTimeout(300);
  const pinned = (await st()).pin;
  await p.evaluate(() => { const s = document.querySelector('input[type=range]') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(s, String(Number(s.max))); s.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.waitForTimeout(300);
  const afterPin = (await st()).pin;
  out.push(`isolate→change-grain: pin ${pinned} → ${afterPin}  ${pinned !== null && afterPin === null ? "✓ stale pin cleared" : "⚠ check"}`);
} catch (e: any) { out.push("PROBE ERROR: " + (e.message || e)); }
finally { await browser.close(); server.stop(true); }
console.log("\n=== interaction-feel probe (real drags, read from live state) ===");
for (const l of out) console.log("  " + l);
