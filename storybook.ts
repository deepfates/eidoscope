// Storybook: drive the rendered viewer through its key states in headless Chromium, screenshot
// each, and stitch a single self-contained gallery.html (images inlined) we can share + eyeball.
// Doubles as visual-regression QA. Run: bun run storybook.ts [htmlfile]
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const file = process.argv[2] ?? "eidoscope-fixture.html";
const url = "file://" + process.cwd() + "/" + file;
mkdirSync("story", { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 2 });
const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url); await p.waitForTimeout(1800);

const set = (id: string, val: string) => p.evaluate(({ id, val }: any) => { const s: any = document.getElementById(id); if (s) { s.value = val; s.dispatchEvent(new Event("change")); } }, { id, val });
const deckClosed = () => p.evaluate(() => { const d = document.getElementById("deck"); if (d?.classList.contains("on")) (window as any).toggleDeck(); });

const shots: { name: string; caption: string }[] = [];
async function shot(name: string, caption: string, setup: () => Promise<void>, settle = 700) {
  try { await setup(); await p.waitForTimeout(settle); await p.screenshot({ path: `story/${name}.png` }); shots.push({ name, caption }); console.log("✓", name); }
  catch (e: any) { console.error("✗", name, e.message); }
}

const axes: string[] = await p.evaluate(() => JSON.parse(document.getElementById("data")!.textContent!).axes.map((a: any) => a.key));

await shot("01-map-regions", "The neighbor map — 1,350 cards laid out by similarity, colored by discovered region.", async () => { await deckClosed(); await set("layout", "mde"); await set("color", "cluster"); await set("size", "hub"); });
await shot("02-map-by-axis", "Same map, colored by a single discovered axis — the technical↔philosophical gradient across the whole corpus.", async () => { await set("color", axes[0]); });
await shot("03-axis-scatter", "Axis scatter — position by any two discovered axes. Interpretable coordinates instead of a meaningless projection.", async () => { await set("color", "cluster"); await set("layout", "axes"); }, 1300);
await shot("04-orbit-3d", "Draggable 3D orbit — the cloud as a solid you turn in the light (front points brighter/larger).", async () => { await set("layout", "orbit"); await p.evaluate(() => { }); }, 900);
await shot("05-focus-neighbors", "Click a card → its nearest neighbors light up and its connections list opens. (Here: the biggest hub.)", async () => { await set("layout", "mde"); await p.evaluate(() => { const D = JSON.parse(document.getElementById("data")!.textContent!); let mi = 0; D.nodes.forEach((n: any, i: number) => { if (n.hub > D.nodes[mi].hub) mi = i; }); (window as any).focusIdx(mi); }); });
await shot("06-region-isolate", "Hover a region in the legend → it isolates with a hull, everything else fades.", async () => { await p.evaluate(() => (window as any).clearFocus?.()); await p.dispatchEvent("#legend [data-cl]", "mouseenter").catch(() => {}); });
await shot("07-deck-influence", "The deck-view: cards as a reader, sorted by influence — title, core, region, and the 3 axes each most commits to.", async () => { await p.evaluate(() => { const l = document.getElementById("legend"); l?.dispatchEvent(new Event("mouseleave")); }); await p.evaluate(() => (window as any).toggleDeck()); });
await shot("08-deck-spectrum", "Sort the deck by an axis and it becomes a readable spectrum — the corpus from most-technical downward.", async () => { await set("dsort", axes[0]); });

await b.close();

// stitch a self-contained gallery
const b64 = (n: string) => "data:image/png;base64," + readFileSync(`story/${n}.png`).toString("base64");
const gallery = `<!doctype html><meta charset=utf-8><title>eidoscope — storybook</title>
<style>body{margin:0;background:#0b0e15;color:#eef2fa;font:15px/1.5 "Inter",system-ui,sans-serif}
header{padding:26px 30px 6px}h1{margin:0;font-size:22px}p.sub{color:#93a1b7;margin:6px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:20px;padding:22px 30px 40px}
figure{margin:0;border:1px solid #232c3c;border-radius:12px;overflow:hidden;background:#141b27}
img{width:100%;display:block;border-bottom:1px solid #232c3c}figcaption{padding:11px 14px;font-size:13px;color:#c7d0de}
figcaption b{color:#eef2fa}</style>
<header><h1>eidoscope 🔭 — storybook</h1><p class=sub>${shots.length} states · rendered from <code>${file}</code> · headless Chromium</p></header>
<div class=grid>${shots.map((s) => `<figure><img src="${b64(s.name)}"><figcaption><b>${s.name.replace(/^\d+-/, "").replace(/-/g, " ")}</b> — ${s.caption}</figcaption></figure>`).join("")}</div>`;
writeFileSync("gallery.html", gallery);
console.log(`\ngallery.html written (${shots.length} states, ${(gallery.length / 1024 / 1024).toFixed(1)}MB) · page errors: ${errs.length || "none"}`);
