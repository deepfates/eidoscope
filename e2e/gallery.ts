// Visual/UX audit gallery — drives the REAL built viewer bundle through the user-story state matrix
// (both maps · both themes · desktop + mobile) and snapshots each state to story/<name>.png, then builds
// story/gallery.html as a captioned contact sheet for human review. Not a pass/fail suite (that's
// viewer.e2e.ts) — this is for *looking*: does every state read well and compose well together.
// Run: cd viewer && bun run build   then   bun run e2e/gallery.ts   (needs viewer/dist + a Pathfinder
// pathfinder.eido in dist for the pf-* shots; they're skipped with a note if absent).
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "viewer", "dist");
if (!existsSync(join(dist, "index.html"))) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build`"); process.exit(2); }
const hasPf = existsSync(join(dist, "pathfinder.eido"));
const out = join(import.meta.dir, "..", "story"); mkdirSync(out, { recursive: true });

const ctype = (f: string) => f.endsWith(".html") ? "text/html" : f.endsWith(".eido") ? "application/octet-stream" : f.endsWith(".css") ? "text/css" : f.endsWith(".js") ? "text/javascript" : "application/octet-stream";
const server = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname;
  const f = p === "/" ? "index.html" : p.slice(1);
  try { return new Response(readFileSync(join(dist, f)), { headers: { "content-type": ctype(f) } }); }
  catch { return new Response(readFileSync(join(dist, "index.html")), { headers: { "content-type": "text/html" } }); }
}});
const base = `http://localhost:${server.port}`;

// ── in-page drivers (real DOM, same controls a user touches) ────────────────────────────────
const setControl = (page: Page, label: string, value: string) => page.evaluate(([label, value]) => {
  const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === label);
  const s = l?.querySelector("select") as HTMLSelectElement | undefined; if (!s) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); return true;
}, [label, value] as [string, string]);
const setGrain = (page: Page, v: number) => page.evaluate((v) => { const s = document.querySelector('input[type=range]') as HTMLInputElement; if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(s, String(v)); s.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const grainMax = (page: Page) => page.evaluate(() => Number((document.querySelector('input[type=range]') as HTMLInputElement)?.max || 0));
const btn = (page: Page, re: RegExp) => page.getByRole("button", { name: re }).first();
const settle = (page: Page, ms = 550) => page.waitForTimeout(ms);
const dismissIntro = (page: Page) => page.evaluate(() => { try { localStorage.setItem("eido-seen", "1"); } catch {} });

type Shot = { name: string; caption: string; map?: string; theme?: "light" | "dark"; vp?: { width: number; height: number }; intro?: boolean; noReady?: boolean; settleMs?: number; setup?: (p: Page) => Promise<void> };
const DESKTOP = { width: 1440, height: 900 }, NARROW = { width: 860, height: 720 }, MOBILE = { width: 390, height: 844 }, LANDSCAPE = { width: 812, height: 375 };

const shots: Shot[] = [
  // ── first impression ──
  { name: "01-intro", caption: "First load — the intro modal (Readwise, light)", intro: true, vp: DESKTOP },
  { name: "02-neighbor-light", caption: "Neighbor map · color by region · light", vp: DESKTOP },
  { name: "03-neighbor-dark", caption: "Neighbor map · region · dark", theme: "dark", vp: DESKTOP },
  // ── smoosh into a dimension ──
  { name: "04-axes-poles", caption: "Axis scatter — positioned by two discovered axes, pole labels on the edges", vp: DESKTOP, setup: async (p) => { await setControl(p, "layout", "axes"); } },
  { name: "05-orbit", caption: "3D orbit — depth cloud", vp: DESKTOP, setup: async (p) => { await setControl(p, "layout", "orbit"); } },
  { name: "06-color-axis", caption: "Color by a discovered axis (continuous low→high gradient)", vp: DESKTOP, setup: async (p) => { const v = await p.evaluate(() => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === "color"); const s = l?.querySelector("select") as HTMLSelectElement; return [...s.options].find((o) => o.value !== "cluster" && !o.value.startsWith("meta:"))?.value || ""; }); await setControl(p, "color", v); } },
  { name: "07-size-commit", caption: "Size = commitment to an axis (|score−50|)", vp: DESKTOP, setup: async (p) => { const v = await p.evaluate(() => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === "size"); const s = l?.querySelector("select") as HTMLSelectElement; return [...s.options].find((o) => o.value !== "uniform" && o.value !== "hub")?.value || "hub"; }); await setControl(p, "size", v); } },
  // ── grain ladder ──
  { name: "08-grain-coarse", caption: "Grain — coarsest (continents)", vp: DESKTOP, setup: async (p) => { await setGrain(p, 0); } },
  { name: "09-grain-fine", caption: "Grain — finest (towns); labels thin at the fit view, reveal on zoom", vp: DESKTOP, setup: async (p) => { await setGrain(p, await grainMax(p)); } },
  // ── drill into a region ──
  { name: "10-isolate", caption: "Legend region isolated — convex hull + others dimmed", vp: DESKTOP, setup: async (p) => { await btn(p, /^isolate region/).click(); } },
  // ── tap a card → read it ──
  { name: "11-focus-detail", caption: "A card focused — neighbor spokes on the map + detail panel (dual links, ranked placements)", vp: DESKTOP, setup: async (p) => { await btn(p, /^deck$/).click(); await settle(p, 300); await p.locator(".grid button").first().click(); } },
  { name: "12-deck", caption: "Deck reader — the corpus as a sortable/filterable list (the a11y surface)", vp: DESKTOP, setup: async (p) => { await btn(p, /^deck$/).click(); } },
  { name: "13-deck-filter-empty", caption: "Deck filtered to zero matches — BUG eid-vtji: blank, no empty-state", vp: DESKTOP, setup: async (p) => { await btn(p, /^deck$/).click(); await settle(p, 250); const f = p.locator('input[placeholder="filter…"]'); await f.fill("zzzznomatchqq"); } },
  { name: "14-search-dim", caption: "Find-a-card search dims non-matching points", vp: DESKTOP, setup: async (p) => { await p.locator('input[placeholder="find a card…"]').fill("alignment"); } },
  // ── frontier telescope (Readwise has --frontier) ──
  { name: "15-frontier", caption: "Frontier — citation edges + ghost papers (cited-but-absent, → arXiv)", vp: DESKTOP, theme: "dark", setup: async (p) => { await btn(p, /cite edges/i).click(); await btn(p, /frontier/i).click(); } },
  // ── responsive ──
  { name: "16-narrow-overlap", caption: "Narrow width (860px) — BUG eid-rnsc: bottom hint/readout collide", vp: NARROW },
  { name: "17-mobile-collapsed", caption: "Mobile fresh load — controls + legend collapsed, map is the hero", vp: MOBILE },
  { name: "18-mobile-controls", caption: "Mobile — controls expanded (tap the bar)", vp: MOBILE, setup: async (p) => { await btn(p, /expand controls/i).click(); } },
  { name: "19-mobile-deck", caption: "Mobile — deck reader open (close ✕ is a 40px tap target; back gesture also closes it)", vp: MOBILE, setup: async (p) => { await btn(p, /^deck$/).click(); } },
  { name: "19b-mobile-detail", caption: "Mobile — card detail as a full-width bottom sheet", vp: MOBILE, setup: async (p) => { await btn(p, /^deck$/).click(); await settle(p, 300); await p.locator(".grid button").first().click(); } },
  { name: "19c-mobile-landscape", caption: "Mobile landscape (812×375) — layout holds, map stays the hero", vp: LANDSCAPE },
  { name: "24-load-error", caption: "Load error (bad ?map=) — error message + reload affordance", map: "doesnotexist.eido", vp: DESKTOP, noReady: true },
  { name: "25-size-uniform", caption: "Size = uniform (every card the same dot)", vp: DESKTOP, setup: async (p) => { await setControl(p, "size", "uniform"); } },
  { name: "26-grain-fine-mid", caption: "Grain — a finer level (distinct from the default), labels reveal as you drill", vp: DESKTOP, setup: async (p) => { const gm = await grainMax(p); await setGrain(p, Math.max(1, gm - 2)); } },
  { name: "27-axes-weak", caption: "Axis scatter on a WEAK axis — the '~ minor axis' hint should show", vp: DESKTOP, setup: async (p) => { await setControl(p, "layout", "axes"); await settle(p, 400); const wk = await p.evaluate(() => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === "x-axis"); const s = l?.querySelector("select") as HTMLSelectElement | undefined; return [...(s?.options || [])].find((o) => o.textContent?.includes("~"))?.value || ""; }); if (wk) await setControl(p, "x-axis", wk); } },
  { name: "28-drill", caption: "Double-click a region drills to a finer grain + fits to it", vp: DESKTOP, setup: async (p) => { const b = await p.evaluate(() => { const cv = document.querySelector("canvas")!; const r = cv.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); let hit = { x: b.x, y: b.y }; for (let i = 0; i < 16; i++) { const x = b.x + ((i % 4) - 1.5) * 24, y = b.y + (Math.floor(i / 4) - 1.5) * 24; await p.mouse.move(x, y); await p.waitForTimeout(90); if ((await p.evaluate(() => (window as any).__eido().hover)) === "point") { hit = { x, y }; break; } } await p.mouse.dblclick(hit.x, hit.y); } },
  { name: "29-hover-tooltip", caption: "Hover a node → tooltip (title · core · hub · top axes)", vp: DESKTOP, setup: async (p) => { const b = await p.evaluate(() => { const c = document.querySelector("canvas")!; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); for (let i = 0; i < 12; i++) { const x = b.x + ((i % 4) - 1.5) * 26, y = b.y + (Math.floor(i / 4) - 1) * 26; await p.mouse.move(x, y); await p.waitForTimeout(120); if ((await p.evaluate(() => (window as any).__eido().hover)) === "point") break; } } },
];
if (hasPf) shots.push(
  { name: "20-pf-region", caption: "Pathfinder SRD (13,830 cards) · color by region", map: "pathfinder.eido", vp: DESKTOP },
  { name: "21-pf-folder", caption: "Pathfinder · color by FOLDER — the geometry recovers the SRD taxonomy (Equipment/Feats/Spells…)", map: "pathfinder.eido", vp: DESKTOP, setup: async (p) => { await setControl(p, "color", "meta:folder"); } },
  { name: "22-pf-grain-fine", caption: "Pathfinder · finest grain (11-level ladder)", map: "pathfinder.eido", vp: DESKTOP, setup: async (p) => { await setGrain(p, await grainMax(p)); } },
  { name: "23-pf-dark", caption: "Pathfinder · dark", map: "pathfinder.eido", theme: "dark", vp: DESKTOP },
  { name: "30-pf-folder-isolate", caption: "Pathfinder · colour by folder, then click 'Equipment' in the legend → isolates just that folder (dims the rest + hull). The real answer to 34-folders-8-colours.", map: "pathfinder.eido", vp: DESKTOP, setup: async (p) => { await setControl(p, "color", "meta:folder"); await settle(p, 600); await p.locator('[role="button"][aria-label="isolate folder Equipment"]').click(); await settle(p, 600); } },
  { name: "31-provenance-header", caption: "A received file introduces itself — corpus title + date in the panel header (Pathfinder map)", map: "pathfinder.eido", vp: DESKTOP },
  { name: "32-provenance-intro", caption: "…and in the intro modal: what corpus, from where, when", map: "pathfinder.eido", intro: true, vp: DESKTOP },
  // the honest reckoning (eid-ypbe): zoom DEEP into the dense core of each corpus — do piled points separate into readable structure, or stay mud?
  { name: "33-pf-core-zoom", caption: "Pathfinder — zoomed deep into the dense center: do the piled points separate?", map: "pathfinder.eido", vp: DESKTOP, setup: async (p) => { await p.mouse.move(700, 460); for (let i = 0; i < 22; i++) { await p.mouse.wheel(0, -150); await p.waitForTimeout(25); } await settle(p, 600); } },
  { name: "34-readwise-core-zoom", caption: "Readwise — zoomed deep into the densest cluster", map: "map.eido", vp: DESKTOP, setup: async (p) => { await p.mouse.move(720, 450); for (let i = 0; i < 22; i++) { await p.mouse.wheel(0, -150); await p.waitForTimeout(25); } await settle(p, 600); } },
  { name: "35-tldr-core-zoom", caption: "tldr — zoomed deep into the densest cluster", map: "tldr.eido", vp: DESKTOP, setup: async (p) => { await p.mouse.move(720, 450); for (let i = 0; i < 22; i++) { await p.mouse.wheel(0, -150); await p.waitForTimeout(25); } await settle(p, 600); } },
  { name: "36-pf-region-zoom", caption: "Pathfinder — isolate one region, THEN zoom in: does isolate make the core legible?", map: "pathfinder.eido", vp: DESKTOP, setup: async (p) => { await btn(p, /^isolate region/).click(); await settle(p, 400); await p.mouse.move(700, 460); for (let i = 0; i < 16; i++) { await p.mouse.wheel(0, -150); await p.waitForTimeout(25); } await settle(p, 600); } },
  // smoosh feel (eid-quf8): same mde→axes switch caught at two moments — if the cloud differs between them, it's animating, not hard-cutting
);

// ── run ────────────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const results: { name: string; caption: string; ok: boolean; errs: string[] }[] = [];
console.log(`gallery: ${shots.length} shots → story/  (Pathfinder ${hasPf ? "included" : "MISSING — pf shots skipped"})\n`);
for (const s of shots) {
  const vp = s.vp || DESKTOP;
  const page = await browser.newPage({ viewport: vp, hasTouch: true, reducedMotion: "no-preference" });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  try {
    await page.addInitScript(({ theme, intro }) => { try { if (!intro) localStorage.setItem("eido-seen", "1"); if (theme) localStorage.setItem("eido-theme", theme); } catch {} }, { theme: s.theme, intro: !!s.intro });
    await page.goto(`${base}/index.html${s.map ? `?map=${s.map}` : ""}`);
    if (s.noReady) await page.waitForSelector('[role="status"]', { timeout: 15000 });
    else await page.waitForFunction(() => !!(window as any).__eido, null, { timeout: 20000 });
    await settle(page, 700);
    if (s.setup) { await s.setup(page); await settle(page, s.settleMs ?? 700); }
    await page.screenshot({ path: join(out, s.name + ".png") });
    results.push({ name: s.name, caption: s.caption, ok: errs.length === 0, errs });
    console.log(`  ${errs.length ? "✗" : "✓"} ${s.name}${errs.length ? "  — " + errs[0] : ""}`);
  } catch (e: any) {
    results.push({ name: s.name, caption: s.caption, ok: false, errs: [String(e.message || e)] });
    console.log(`  ✗ ${s.name}  — ${e.message || e}`);
  } finally { await page.close(); }
}
await browser.close();
server.stop(true);

// ── contact sheet ──
const cards = results.map((r) => `<figure class="${r.ok ? "" : "err"}"><img src="${r.name}.png" loading="lazy"><figcaption><b>${r.name}</b>${r.ok ? "" : ' <span class="badge">console/page error</span>'}<br>${r.caption}${r.errs.length ? `<br><code>${r.errs[0].slice(0, 160)}</code>` : ""}</figcaption></figure>`).join("\n");
writeFileSync(join(out, "gallery.html"), `<!doctype html><meta charset=utf8><title>eidoscope viewer — visual audit</title><style>
body{margin:0;background:#0a0a0b;color:#e5e5ea;font:14px/1.5 ui-sans-serif,system-ui}
header{padding:20px 24px;border-bottom:1px solid #26262b}h1{margin:0;font-size:18px}p{margin:4px 0 0;color:#a1a1aa}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:18px;padding:24px}
figure{margin:0;background:#141417;border:1px solid #26262b;border-radius:10px;overflow:hidden}
figure.err{border-color:#b91c1c}
img{width:100%;display:block;background:#000;border-bottom:1px solid #26262b}
figcaption{padding:10px 12px;color:#c7c7cf}code{color:#fca5a5;font-size:12px}.badge{background:#b91c1c;color:#fff;padding:1px 6px;border-radius:6px;font-size:11px}
</style><header><h1>eidoscope viewer — visual/UX audit</h1><p>${results.length} states · ${results.filter((r) => r.ok).length} clean · ${results.filter((r) => !r.ok).length} with console/page errors · review each for visual defects</p></header><div class=grid>${cards}</div>`);
console.log(`\n→ story/gallery.html  (${results.filter((r) => !r.ok).length} shots had console/page errors)`);
