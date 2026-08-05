// Video capture to VERIFY ANIMATIONS that still screenshots can't show: deck.gl's rAF/GPU attribute
// transitions (layout smoosh mde↔axes↔orbit) and reveal-on-zoom labels. Playwright records the context
// to webm; we then have ffmpeg pull evenly-spaced stills so we can LOOK at the in-between frames and
// confirm motion (intermediate positions) vs a hard cut. Run: bun run e2e/video.ts  (needs viewer/dist).
import { chromium, type Page } from "playwright";
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "viewer", "dist");
if (!existsSync(join(dist, "index.html"))) { console.error("✗ viewer/dist/index.html missing — build first"); process.exit(2); }
const hasPf = existsSync(join(dist, "pathfinder.eido"));
const out = join(import.meta.dir, "..", "story", "video"); rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const ctype = (f: string) => f.endsWith(".html") ? "text/html" : f.endsWith(".eido") ? "application/octet-stream" : "application/octet-stream";
const server = Bun.serve({ port: 0, fetch(req) {
  const f = new URL(req.url).pathname.replace(/^\//, "") || "index.html";
  try { return new Response(readFileSync(join(dist, f)), { headers: { "content-type": ctype(f) } }); }
  catch { return new Response(readFileSync(join(dist, "index.html")), { headers: { "content-type": "text/html" } }); }
} });
const base = `http://localhost:${server.port}`;
const setControl = (page: Page, label: string, value: string) => page.evaluate(([label, value]) => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === label); const s = l?.querySelector("select") as HTMLSelectElement | undefined; if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); }, [label, value] as [string, string]);
const wait = (p: Page, ms: number) => p.waitForTimeout(ms);

// MODE=switch → light readwise map (fast/smooth) to judge the mde→axes ease frame-by-frame at 24fps
const map = process.env.MODE === "switch" ? "map.eido" : hasPf ? "pathfinder.eido" : "map.eido";
// env knobs so one harness characterises desktop/mobile × reduced-motion on/off:
//   MOBILE=1  → 390×844 viewport   RM=reduce → emulate prefers-reduced-motion (the iOS "Reduce Motion" setting)
const MOBILE = process.env.MOBILE === "1";
const RM = process.env.RM === "reduce" ? "reduce" : "no-preference";
const VP = MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 };
console.log(`config: ${MOBILE ? "mobile" : "desktop"} ${VP.width}x${VP.height} · reduced-motion=${RM}`);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VP, recordVideo: { dir: out, size: VP }, reducedMotion: RM as any, hasTouch: MOBILE });
const p = await ctx.newPage();
await p.addInitScript(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });
await p.goto(`${base}/index.html?map=${map}`);
// wait until the map is actually LOADED (points present), not just the seam existing — pathfinder.eido is big
await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 20000 });
await p.waitForFunction(() => ((window as any).__eido?.()?.regions ?? 0) > 0, null, { timeout: 20000 }).catch(() => {});
await wait(p, 2500); // let the initial mde layout fully settle before we touch anything
if (MOBILE) { await p.locator('[aria-label="expand controls"]').click().catch(() => {}); await wait(p, 400); } // panel is collapsed under 640px

if (process.env.MODE === "switch") {
  // one clean mde→axes, tight window either side, to see camera+points ease vs snap
  console.log("→ mde→axes (isolated)"); await setControl(p, "layout", "axes"); await wait(p, 1800);
} else if (process.env.MODE === "orbitzoom") {
  // ISOLATE the reported bug: switch to 3D orbit, then wheel-zoom IN — do the points shrink? (they shouldn't)
  console.log("→ orbit"); await setControl(p, "layout", "orbit"); await wait(p, 2500);
  console.log("→ zoom-IN in orbit");
  await p.mouse.move(VP.width / 2, VP.height / 2);
  for (let i = 0; i < 16; i++) { await p.mouse.wheel(0, -140); await wait(p, 160); } // slow so each step lands on a frame
  await wait(p, 1000);
} else {
  // Each transition gets a clean 2.5s window so its ~700ms animation plays with settled frames either side.
  console.log("→ mde→axes");   await setControl(p, "layout", "axes");  await wait(p, 2500);
  console.log("→ axes→orbit"); await setControl(p, "layout", "orbit"); await wait(p, 2500);
  console.log("→ orbit→mde");  await setControl(p, "layout", "mde");   await wait(p, 2500);
  // reveal-on-zoom: wheel into the dense core slowly so labels should progressively appear
  console.log("→ zoom-in");
  await p.mouse.move(VP.width / 2, VP.height / 2);
  for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, -150); await wait(p, 90); }
  await wait(p, 1000);
}

await p.close(); await ctx.close(); // finalizes the webm
await browser.close(); server.stop();

const webm = readdirSync(out).find((f) => f.endsWith(".webm"));
if (!webm) { console.error("✗ no video produced"); process.exit(1); }
console.log("video:", join(out, webm));

// pull evenly-spaced stills so we can look at the in-between frames
const { spawnSync } = await import("node:child_process");
const r = spawnSync("ffmpeg", ["-y", "-i", join(out, webm), "-vf", "fps=24", join(out, "f-%03d.png")], { encoding: "utf8" });
if (r.status !== 0) { console.error("ffmpeg failed:", r.stderr?.slice(-400)); process.exit(1); }
const frames = readdirSync(out).filter((f) => f.startsWith("f-")).sort();
console.log(`extracted ${frames.length} frames → story/video/f-*.png`);
