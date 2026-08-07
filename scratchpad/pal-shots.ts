// Visual verification for the theme-derived palette: serve the real built viewer + the real corpora,
// switch through the themes, screenshot each. Run: bun run scratchpad/pal-shots.ts
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const DIST = process.cwd() + "/viewer/dist";
const srv = Bun.serve({
  port: 8299,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const f = path === "/" ? "/index.html" : path;
    try { return new Response(readFileSync(DIST + f), { headers: { "content-type": f.endsWith(".html") ? "text/html" : "application/octet-stream" } }); }
    catch { return new Response("nope", { status: 404 }); }
  },
});

const THEMES = ["black", "light", "synthwave", "nord", "retro"];
const CORPORA = [["map", "map.eido"], ["tldr", "tldr.eido"]];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });   // skip the intro overlay
const p = await ctx.newPage();
const _unused = await Promise.resolve()//
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
const info: string[] = [];
p.on("console", (m) => { if (m.text().includes("[eido] palette")) info.push(m.text()); });

for (const [tag, file] of CORPORA) {
  for (const t of THEMES) {
    await p.goto(`http://localhost:8299/?map=${file}&theme=${t}`);
    await p.waitForTimeout(2500);
    const st = await p.evaluate(() => (window as any).__eido?.());
    await p.screenshot({ path: `shell-pal-${t}${tag === "map" ? "" : "-" + tag}.png` });
    console.log(tag, t, "ground=" + st?.theme, "regions=" + st?.regions, "pal0=" + JSON.stringify(st?.pal?.[0]));
  }
}
console.log("\n" + info.join("\n"));
console.log("\npage/console errors:", errs.length ? errs : "none");
await b.close();
srv.stop();
