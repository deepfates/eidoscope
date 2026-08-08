// Integration net for the NEW Svelte + deck.gl viewer. Builds a SYNTHETIC map, encodes it to the real
// .eido wire format, serves the REAL built viewer/dist/index.html beside it, drives it in Chromium, and
// asserts interaction invariants through the read-only window.__eido() seam (+ __eidoProject for exact
// world→screen picking). This is the parity gate (eid-55ln): it exercises the actual production bundle,
// not a mock. Hermetic (no fixture, no 15k run, deterministic — no RNG).
// Run: bun run e2e/viewer.e2e.ts   (exits non-zero on any failure). Requires `cd viewer && bun run build`.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { encodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";

// 3 blobs · 30 each · a NESTED 4-level ladder [3,6,12,24] refining by index. Node 0 sits at the ORIGIN
// (blob centers are symmetric so the map centers on it) — a center click/tap/dbl-click is a guaranteed hit.
import { synthMap as synth, altSynth } from "./synth.ts";
import { parseIdSet, resolveIdSet, encodeIdxSet, fnv1a } from "../viewer/src/idset.ts";

const distIndex = join(import.meta.dir, "..", "viewer", "dist", "index.html");
if (!existsSync(distIndex)) { console.error("✗ viewer/dist/index.html missing — run `cd viewer && bun run build` first"); process.exit(2); }
const indexHtml = readFileSync(distIndex);
const eido = encodeMap(synth());
const altEido = encodeMap(altSynth());

// serve the built index + synthetic .eido on an ephemeral port (production path: the app fetch()es ./map.eido)
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/map.eido") return new Response(eido, { headers: { "content-type": "application/octet-stream" } });
    if (path === "/alt.eido") return new Response(altEido, { headers: { "content-type": "application/octet-stream" } });
    return new Response(indexHtml, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://localhost:${server.port}`;

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 2, hasTouch: true });
const pageErrs: string[] = []; p.on("pageerror", (e) => pageErrs.push(String(e)));
const consoleErrs: string[] = []; p.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });

const st = () => p.evaluate(() => (window as any).__eido());
const proj = (xy: number[]) => p.evaluate((xy) => (window as any).__eidoProject(xy) as number[], xy);
const btn = (re: RegExp) => p.locator("button", { hasText: re }).first();
// ── the toolbar is a row of real menus now (DaisyUI classes on Bits UI behaviour), so the harness drives the
// SAME affordances a person does: open the menu, click the item. Triggers carry data-menu="<scope>:<channel>"
// and items data-opt="<scope>:<channel>:<value>" purely as stable test handles — the semantics asserted below
// are unchanged from the select-driven era.
const closeMenus = async () => { await p.evaluate(() => (document.querySelector('[data-menu][data-state="open"]') as HTMLElement | null)?.click()); await p.waitForTimeout(80); };
const menu = async (channel: string) => { await closeMenus(); await p.click(`[data-menu="bar:${channel}"]`); await p.waitForTimeout(180); };
// pick a value on a channel. The colour popover deliberately STAYS open after a pick (it is also the legend),
// so callers that then click a legend row don't have to reopen it.
const setControl = async (channel: string, value: string) => { await menu(channel); await p.click(`[data-opt="bar:${channel}:${value}"]`); await p.waitForTimeout(180); if (channel !== "color") await closeMenus(); };
// grain lives in the colour popover now (it modifies the region clustering it legends)
const setGrain = async (v: number) => {
  // grain is a first-class toolbar control (a parameter of the region dimension, not of the colour channel)
  await p.evaluate((v) => { const s = document.querySelector('[data-testid=grain]') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(s, String(v)); s.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  await p.waitForTimeout(120);
};
// deck's onClick fires the SAME way for a desktop mouse click and a touch tap; Playwright can't cleanly
// drive deck's mouse-gesture recognizer (a harness limit), but touchscreen.tap reaches it reliably — so a
// tap is the honest proxy for "click/tap a card". Card-open is OPTIMISTIC (immediate — no debounce);
// a double-click undoes it and drills instead (eid-54lx).

console.log("eidoscope NEW viewer E2E (Svelte + deck.gl)\n");
try {
  await p.goto(base + "/index.html");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click(); // dismiss intro
  await p.waitForTimeout(150);

  // 1. clean load at default grain
  ok(pageErrs.length === 0, "no page errors on load" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  let s = await st();
  ok(s.grain === 2 && s.k === 12, `opens at default grain (12 regions) — got grain=${s.grain} k=${s.k}`);
  ok(s.regions === 12, `deck sees 12 non-empty regions at default grain — got ${s.regions}`);

  // 2. grain slider moves across the ladder
  await setGrain(0); s = await st();
  ok(s.grain === 0 && s.k === 3, `grain → coarsest (3) — grain=${s.grain} k=${s.k}`);
  await setGrain(3); s = await st();
  ok(s.grain === 3 && s.k === 24, `grain → finest (24) — grain=${s.grain} k=${s.k}`);

  // 3. LABELS REVEAL ON ZOOM (the drift we fixed): at finest grain, fit view decluttts; zooming in reveals more
  await btn(/^reset view$/).click(); await p.waitForTimeout(200); await setGrain(3); await p.waitForTimeout(200);
  const fit = await st(); const lFit = fit.labels;
  const [cx, cy] = await proj([0, 0]);
  await p.mouse.move(cx, cy); // wheel targets whatever's under the cursor — put it over the canvas
  for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -140); await p.waitForTimeout(20); }
  await p.waitForTimeout(300);
  const zm = await st();
  ok(zm.zoom > fit.zoom, `wheel actually zoomed the deck — ${fit.zoom.toFixed(2)}→${zm.zoom.toFixed(2)}`);
  ok(zm.labels > lFit, `zooming in reveals more region labels — fit=${lFit} → zoom=${zm.labels}`);

  // 4. THE REGRESSION: legend-click isolates + zooms but must NOT change grain; re-click releases
  await btn(/^reset view$/).click(); await p.waitForTimeout(200); s = await st(); const g0 = s.grain, z0 = s.zoom;
  await menu("color");   // the legend IS the colour picker's popover now
  const legendItem = p.locator('button[aria-label^="isolate region"]').first();
  await legendItem.click(); await p.waitForTimeout(200); s = await st();
  ok(s.grain === g0, `legend-click leaves grain unchanged — grain ${g0}→${s.grain}`);
  ok(s.pin !== null, "legend-click pins/isolates the region");
  // THE INTERACTION LAW: isolating is a filter and must NOT move the camera (this assertion used to
  // demand the opposite — it was enforcing the incidental camera flight). The explicit `fit` button
  // in the region pane is the only thing that frames it.
  ok(Math.abs(s.zoom - z0) < 0.01, `legend-click leaves the camera alone — ${z0.toFixed(2)}→${s.zoom.toFixed(2)}`);
  await legendItem.click(); await p.waitForTimeout(200); s = await st();   // popover stays open through an isolate
  ok(s.pin === null, `re-click releases the pin — pin=${s.pin}`);
  // …and the explicit `fit` in the region pane is what DOES move the camera (isolate again to get the pane)
  await legendItem.click(); await p.waitForTimeout(200);
  await closeMenus();
  await p.locator("[data-testid=region-fit]").first().click();
  await p.waitForTimeout(700); s = await st();
  ok(s.zoom > z0 * 1.15, `the region pane's fit button DOES zoom in — ${z0.toFixed(2)}→${s.zoom.toFixed(2)}`);
  await menu("color"); await legendItem.click(); await p.waitForTimeout(200); await closeMenus();   // release, back to a clean slate

  // 5. drill via map double-click steps grain finer (and does NOT open a card)
  await btn(/^reset view$/).click(); await p.waitForTimeout(200); const gd = (await st()).grain;
  await p.mouse.dblclick(cx, cy); await p.waitForTimeout(400); s = await st();
  ok(s.grain > gd, `double-click drills one step finer — grain ${gd}→${s.grain}`);
  // NOTE: the "drill must not ALSO open a card" debounce is real (real-device dblclick fires deck.onClick
  // twice), but Playwright's synthetic mouse doesn't drive deck's onClick deterministically, so asserting
  // it here would pass vacuously — deliberately NOT asserted rather than give false confidence.

  // 6. tap/click a card → detail panel (exact node-0 pixel via project; desktop click shares this onClick path)
  await btn(/^reset view$/).click(); await p.waitForTimeout(200);
  const [nx, ny] = await proj([0, 0]);
  await p.touchscreen.tap(nx, ny); await p.waitForTimeout(1200); s = await st();  // generous settle for the headless tab (card-open itself is immediate)
  ok(s.detail === true && s.focus === 0, `tapping a card opens its detail panel — detail=${s.detail} focus=${s.focus}`);
  // …and its axis placements actually render (guards the lazy-notes path: a sparse-cache proxy that
  // answers only `get` reads as empty under Svelte's $state, which checks `has` first — found on the
  // first real new-format corpus, invisible to every assertion that only checked the panel opened)
  const nPlacements = await p.evaluate(() => document.querySelectorAll('[role="dialog"][aria-label="card detail"] [data-placement]').length);
  ok(nPlacements > 0, `the open card shows its axis placements — ${nPlacements} tracks`);

  // 8. FRONTIER: cite + ghost toggles flip; hovering a ghost reports 'ghost' (not a wrong card); click → arXiv
  await btn(/^reset view$/).click(); await p.waitForTimeout(200);
  await menu("layout"); await p.click('[data-opt="bar:overlay:cite"]'); await p.waitForTimeout(150);
  await menu("layout"); await p.click('[data-opt="bar:overlay:ghosts"]'); await p.waitForTimeout(200); await closeMenus(); s = await st();
  ok(s.cite === true && s.ghosts === true, `cite + frontier toggles flip on — cite=${s.cite} ghosts=${s.ghosts}`);
  const [gx, gy] = await proj([0.8, 0.5]);
  await p.mouse.move(gx, gy); await p.waitForTimeout(200); s = await st();
  ok(s.hover === "ghost", `hovering a ghost reports kind 'ghost' (not a card) — hover=${s.hover}`);
  // deck's REAL picking at the ghost's screen pixel returns the ghost + its arXiv url — the exact machinery
  // onClick uses to open it (onClick→window.open shares the tap path proven for nodes above). Playwright
  // can't drive deck's tap recognizer at off-center pixels, so we assert through deck's own pick, not a fake.
  const pick = await p.evaluate(([x, y]) => (window as any).__eidoPick(x, y), [gx, gy]);
  ok(!!pick && pick.layer === "ghosts" && /arxiv\.org\/abs\/2101\.00001/.test(pick.url), `a ghost is click-pickable at its pixel and carries its arXiv url (→ opens on click) — pick=${JSON.stringify(pick)}`);

  // 9. THEME toggle flips data-theme + persists
  await btn(/^reset view$/).click(); await p.waitForTimeout(150);
  const t0 = (await st()).theme;
  await p.locator('button[aria-label="toggle light or dark theme"]').click(); await p.waitForTimeout(150);
  let ts = await st();
  const attr = await p.evaluate(() => document.documentElement.dataset.theme), stored = await p.evaluate(() => localStorage.getItem("eido-theme"));
  ok(ts.theme !== t0 && attr === ts.themeName && stored === ts.themeName, `theme toggle flips ground + persists — ${t0}→${ts.theme} (${ts.themeName}) attr=${attr} stored=${stored}`);
  // the picker: any curated theme stamps <html data-theme> and still maps to a legible canvas ground
  await menu("theme"); await p.click('[data-opt="bar:theme:nord"]'); await p.waitForTimeout(200); ts = await st();
  const attr2 = await p.evaluate(() => document.documentElement.dataset.theme);
  // canvas ground is read from the theme's OWN base-100 (nord is a light theme in DaisyUI 5), not a hardcoded flag
  ok(ts.themeName === "nord" && attr2 === "nord" && ts.theme === "light", `theme picker swaps the DaisyUI theme + reads its true canvas ground — name=${ts.themeName} attr=${attr2} canvas=${ts.theme}`);
  ok(new URL(p.url()).searchParams.get("theme") === "nord", `the chosen theme rides the shareable URL — ${new URL(p.url()).search}`);
  // the MAP PALETTE is derived from the theme's own tokens (eid-caza): switching themes must repaint the
  // region dots, and the legend swatches must be the SAME colours the canvas uses — one source of truth.
  const nordPal = (await st()).pal;
  const swatch = async () => p.evaluate(() => {
    const b = document.querySelector('[aria-label^="isolate region"]') as HTMLElement | null;
    const sw = b?.querySelector("span") as HTMLElement | null;
    return sw ? getComputedStyle(sw).backgroundColor : "";
  });
  const legendFirst = async () => { await p.click('[data-menu="bar:color"]'); await p.waitForTimeout(180); const c = await swatch(); await closeMenus(); return c; };
  const nordSwatch = await legendFirst();
  await menu("theme"); await p.click('[data-opt="bar:theme:retro"]'); await p.waitForTimeout(250); await closeMenus();
  const retroPal = (await st()).pal, retroSwatch = await legendFirst();
  ok(JSON.stringify(nordPal) !== JSON.stringify(retroPal), `switching theme repaints the region colours — nord ${JSON.stringify(nordPal[0])} vs retro ${JSON.stringify(retroPal[0])}`);
  ok(nordSwatch !== retroSwatch, `legend swatches follow the theme too — ${nordSwatch} → ${retroSwatch}`);
  const rgbOf = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  ok(retroSwatch === rgbOf(retroPal[0]) && nordSwatch === rgbOf(nordPal[0]), `legend swatch === the map's own colour for region 0 — ${retroSwatch} vs ${rgbOf(retroPal[0])}`);
  await menu("theme"); await p.click('[data-opt="bar:theme:black"]'); await p.waitForTimeout(150); await closeMenus();

  // 10. DECK shows the whole corpus (was capped at 300) + unread-only filters
  await btn(/^reset view$/).click(); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(200);
  const all = await p.locator("[data-deck-card]").count();
  ok(all === 90, `deck lists the whole corpus (90 cards, not capped) — got ${all}`);
  await btn(/unread only/i).click(); await p.waitForTimeout(200);
  const unread = await p.locator("[data-deck-card]").count();
  ok(unread < all && unread === 60, `unread-only drops read cards — ${all}→${unread}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);

  // 11. reset clears everything back to defaults
  await btn(/^reset view$/).click(); await p.waitForTimeout(250); s = await st();
  ok(s.grain === 2 && s.pin === null && s.focus === null && s.detail === false, `reset restores default grain + clears pin/focus/detail — ${JSON.stringify({ grain: s.grain, pin: s.pin, focus: s.focus, detail: s.detail })}`);

  // 11b. HISTORY: browser Back closes an open overlay (the mobile-escape fix, eid-fktf)
  await btn(/^reset view$/).click(); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(200);
  ok((await st()).deckOpen === true, "deck opens (pushes history)");
  await p.goBack(); await p.waitForTimeout(300);
  ok((await st()).deckOpen === false, "browser Back closes the deck — mobile back gesture escapes the modal (eid-fktf)");

  // 11c. DEEP-LINK: view state mirrors to the URL, and a link restores it (incl. a specific card) — eid-yxqu
  await btn(/^reset view$/).click(); await p.waitForTimeout(150);
  await setControl("layout", "axes"); await setGrain(0); await p.waitForTimeout(250);
  let url = new URL(p.url());
  ok(url.searchParams.get("layout") === "axes" && url.searchParams.get("grain") === "0", `view state mirrors to URL — ${url.search}`);
  // a shared link with a layout + a specific card restores both
  await p.goto(`${base}/index.html?layout=axes&card=d5`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(500);
  s = await st();
  ok(s.layout === "axes", `?layout=axes restores the layout — got ${s.layout}`);
  ok(s.detail === true && s.focus === 5, `?card=d5 deep-links straight to that card — detail=${s.detail} focus=${s.focus}`);

  // 11d. FOCUS TRAP: opening the deck moves focus inside it and Tab stays trapped (eid-vxm2)
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click().catch(() => {}); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(300);
  const inDeck = () => p.evaluate(() => { const d = document.querySelector('[role="dialog"][aria-label="deck reader"]'); return !!d && d.contains(document.activeElement); });
  ok(await inDeck(), "opening the deck moves focus inside the modal");
  await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.waitForTimeout(100);
  ok(await inDeck(), "Tab keeps focus trapped inside the deck (eid-vxm2)");

  // 11e. FACET ISOLATE: colour by a facet, click a facet legend row → isolates just that value (eid-zvh9)
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click().catch(() => {}); await p.waitForTimeout(150);
  await setControl("color", "author"); await p.waitForTimeout(250);  // dimension KEY (the registry replaced the old meta: prefix)
  const facetRow = p.locator('button[aria-label^="isolate author"]').first();   // the colour popover stays open after the pick
  await facetRow.click(); await p.waitForTimeout(250);
  let fs = await st();
  ok(fs.facetPin != null, `clicking a facet legend row isolates that value — facetPin=${JSON.stringify(fs.facetPin)}`);
  await facetRow.click(); await p.waitForTimeout(250);
  fs = await st();
  ok(fs.facetPin == null, `re-clicking releases the facet isolate — facetPin=${JSON.stringify(fs.facetPin)}`);
  await closeMenus();

  // 11f. MISSING METADATA: the bare card (no author/date/url/source) still renders cleanly — no empty '·', no broken links (eid-m107)
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click().catch(() => {}); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(250);
  await p.locator('input[placeholder="find in list…"]').fill("Doc 2.29");   // unique to the bare last card
  await p.waitForTimeout(250);
  await p.locator("[data-deck-card]").first().click(); await p.waitForTimeout(350);
  const bare = await p.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="card detail"]');
    if (!d) return null;
    const meta = (d.querySelector("[data-meta]")?.textContent || "").trim();
    return { hasTitle: !!d.querySelector(".font-bold"), meta, anchors: [...d.querySelectorAll("a")].length };
  });
  ok(!!bare?.hasTitle, "bare card still shows its detail panel (title present)");
  ok(!!bare && bare.meta.length > 0 && !/^·|·$|·\s*·/.test(bare.meta), `meta line shows the present field(s) only, no empty '·' — meta="${bare?.meta}"`);
  ok(bare?.anchors === 0, `no broken reader/source links when the card has none — anchors=${bare?.anchors}`);

  // 12. ?map= loads a DIFFERENT corpus from the SAME built viewer (the dual-deploy path)
  await p.goto(base + "/index.html?map=alt.eido");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(250);
  const alt = await st();
  ok(alt.k === 2 && alt.regions === 2, `?map=alt.eido loads the alternate 2-region map (not the default 12) — k=${alt.k} regions=${alt.regions}`);

  // 12b. PRESENCE-GATING (eid-3zao): a control whose backing data THIS corpus lacks does not render —
  // absent, not disabled. alt.eido carries ONE cluster level, no read-state, no cite/ghosts, no vectors
  // and no dates, so every control fed by those is gone (the default synth map proves the presence side:
  // grain at #2, cite/frontier at #8, unread-only at #10, + axis just below at #13).
  await btn(/explore/i).click().catch(() => {}); await p.waitForTimeout(150);
  ok((await p.locator("[data-testid=grain]").count()) === 0, "grain slider absent when the hierarchy has a single level");
  ok((await p.locator('[data-menu="bar:axis"]').count()) === 0, "+ axis (query) absent when the file carries no card vectors");
  await menu("layout");
  ok((await p.locator('[data-opt="bar:overlay:cite"]').count()) === 0 && (await p.locator('[data-opt="bar:overlay:ghosts"]').count()) === 0, "cite/frontier overlay toggles absent without citation data");
  await closeMenus();
  await btn(/^deck$/).click(); await p.waitForTimeout(250);
  ok((await p.locator("button", { hasText: /unread only/i }).count()) === 0, "unread-only absent when the corpus carries no read state");
  const altSort = await p.evaluate(() => [...document.querySelectorAll('select[aria-label="sort the deck"] option')].map((o) => o.textContent));
  ok(!altSort.includes("date") && altSort.length === 3, `deck sort offers only dimensions this corpus has (no date) — ${JSON.stringify(altSort)}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);

  // 13. OPEN ANY .eido by DROPPING a file — the "hand someone a file" story (eid-0gs7). Reload the default
  // 12-region map, then drop the 2-region alt file onto the app; it should tear down + re-mount to 2 regions.
  await p.goto(base + "/index.html");
  await p.waitForFunction(() => ((window as any).__eido?.()?.regions ?? 0) > 2, null, { timeout: 15000 });
  // …and the presence side of 12b: the synth map DOES carry card vectors, so + axis renders here.
  ok((await p.locator('[data-menu="bar:axis"]').count()) === 1, "+ axis (query) present when the file carries card vectors");
  await p.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch("/alt.eido")).arrayBuffer());
    const file = new File([bytes], "dropped.eido", { type: "application/octet-stream" });
    const dt = new DataTransfer(); dt.items.add(file);
    const root = document.querySelector('[role="application"]')!;
    root.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => (window as any).__eido?.()?.regions === 2, null, { timeout: 15000 }).catch(() => {});
  const dropped = await st();
  ok(dropped.k === 2 && dropped.regions === 2, `dropping a .eido file opens it (12-region → dropped 2-region) — k=${dropped.k} regions=${dropped.regions}`);

  // ═══ 14. SELECT (eid-r8t6) — circle dots → a held, materialized set → verbs ═══════════════════════
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click().catch(() => {});
  await p.waitForTimeout(200);

  // 14a. it is an explicit MODE: the toolbar button, the `s` key and Escape all drive the same state
  await p.click('[data-testid="bar:select"]'); await p.waitForTimeout(150);
  ok((await st()).selectMode === true, "the select button enters select mode");
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  ok((await st()).selectMode === false, "Escape leaves select mode (before it touches the overlay stack)");
  await p.keyboard.press("s"); await p.waitForTimeout(150);
  ok((await st()).selectMode === true, "the `s` key toggles select mode");

  // 14b. a REAL pointer-drawn lasso around blob 1 (indices 30..59, centred at world [1.6, 1.1]) holds
  // exactly that clump — nothing from the other two blobs.
  const [bx, by] = await proj([1.6, 1.1]);
  const [ex] = await proj([2.0, 1.1]);
  const rad = Math.abs(ex - bx);
  await p.mouse.move(bx + rad, by);
  await p.mouse.down();
  for (let a = 1; a <= 36; a++) { const t = (a / 36) * Math.PI * 2; await p.mouse.move(bx + rad * Math.cos(t), by + rad * Math.sin(t)); }
  await p.mouse.up();
  await p.waitForTimeout(400);
  s = await st();
  ok(s.selection === 30, `a pointer-drawn lasso holds exactly the circled clump (blob 1 = 30 cards) — got ${s.selection}`);
  const synthIds = synth().ids;
  const selParam = await p.evaluate(() => new URL(location.href).searchParams.get("sel"));
  const selIdx = selParam ? (resolveIdSet(parseIdSet(selParam)!, synthIds) ?? []) : [];
  ok(selIdx.length === 30 && selIdx.every((i) => i >= 30 && i < 60), `the held set decodes to the RIGHT 30 cards (all of blob 1, none of the others) — e.g. ${selIdx.slice(0, 3).join(",")}`);
  ok(!!selParam && selParam.length < 30 * 4, `…and it is COMPACT: ${selParam?.length} chars for 30 cards, not ~${30 * 4 - 1} spelled-out ids (eid-0iql)`);

  // 14c. THE EXPLAIN STEP: the pane says what distinguishes the set, not just how many it grabbed
  const selPane = await p.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="selection detail"]');
    if (!d) return null;
    return {
      count: (d.querySelector("[data-sel-count]")?.textContent || "").trim(),
      terms: [...d.querySelectorAll("[data-sel-terms] .badge")].map((e) => (e.textContent || "").trim()),
      axes: [...d.querySelectorAll("[data-sel-axis]")].length,
      verbs: [...d.querySelectorAll("button[data-testid]")].map((e) => (e as HTMLButtonElement).dataset.testid),
      derivDisabled: (d.querySelector('[data-testid="sel-derive"]') as HTMLButtonElement | null)?.disabled,
    };
  });
  ok(selPane?.count === "30 cards", `the reading pane shows the selection count — "${selPane?.count}"`);
  ok(!!selPane && selPane.terms.includes("beta"), `the pane EXPLAINS the set: blob 1's distinctive term surfaces — terms=[${selPane?.terms.join(", ")}]`);
  ok((selPane?.axes ?? 0) === 2, `the pane names the set's most-distinctive axes — got ${selPane?.axes}`);
  ok(JSON.stringify(selPane?.verbs) === JSON.stringify(["sel-filter", "sel-fit", "sel-export", "sel-derive", "sel-clear"]), `the verbs appear on a held set — ${JSON.stringify(selPane?.verbs)}`);
  ok(selPane?.derivDisabled === false, "the `derive axis` verb is LIVE on a held set");

  // 14c-bis. DERIVE: mint an axis from the examples, then place it. Minting alone must move nothing.
  const beforeColors = await p.evaluate(() => [0, 30, 60].map((i) => (window as any).__eidoColor(i)));
  await p.locator('[data-testid="derive-label"]').fill("blobby");
  await p.click('[data-testid="sel-derive"]'); await p.waitForTimeout(300);
  s = await st();
  ok(s.derived === 1 && s.dims.includes("d0"), `derive mints a first-class dimension — derived=${s.derived}`);
  ok(s.color === "region" && s.selection === 30, "…and THE LAW holds: it places itself on nothing, and the selection stays held");
  // it is in the registry, so every channel menu offers it
  await menu("color");
  const inMenu = await p.locator('[data-opt="bar:color:d0"]').count();
  await closeMenus();
  ok(inMenu === 1, "the derived dimension appears in the colour menu like any other dimension");
  // place it on colour from the pane — NOW the map repaints
  await p.click('[data-testid="derive-place-color"]'); await p.waitForTimeout(350);
  s = await st();
  const afterColors = await p.evaluate(() => [0, 30, 60].map((i) => (window as any).__eidoColor(i)));
  ok(s.color === "d0", `placing it on colour is a separate act — color=${s.color}`);
  ok(JSON.stringify(afterColors) !== JSON.stringify(beforeColors), "…and the map's actual card colours change");
  // the circled blob really does score highest on its own axis (the direction means something)
  const scoreOrder = await p.evaluate(() => {
    const g = (window as any).__eido();
    return g.color;
  });
  ok(scoreOrder === "d0", "the derived axis is what's painting");
  // eid-0iql: the derived axis rides as d=<label>~<key>:<set>, and because its examples ARE the held
  // selection, the set is the one-char reference `s` — the 30 ids ride ONCE (in sel=), not twice.
  const dParam = new URL(p.url()).searchParams.get("d");
  ok(dParam === "blobby~d0:s", `the derived axis rides as d=<label>~<key>:<set>, deduped against sel= — got "${dParam}"`);
  const deriveUrl = p.url();
  await p.goto(deriveUrl);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(700);
  s = await st();
  ok(s.derived === 1 && s.color === "d0", `?d= re-derives the axis on load and the placement survives — derived=${s.derived} color=${s.color}`);
  // LABEL FIDELITY (eid-0iql): the axis comes back under the NAME it was shared with, not a re-derived one
  const colorNameAfter = await p.evaluate(() => (document.querySelector('[data-menu="bar:color"]') as HTMLElement)?.textContent?.trim());
  ok(!!colorNameAfter?.includes("≈ blobby"), `…and under its OWN LABEL — toolbar says "${colorNameAfter}"`);
  // KEY FIDELITY (eid-0iql): channels name derived dims by key, so a restored dim must come back under the
  // key the URL carries — even a non-zero one (positional renumbering re-painted shared views with the
  // WRONG axis's direction and label whenever a sibling dim hadn't survived the link).
  const sel3060 = "*" + encodeIdxSet(Array.from({ length: 30 }, (_, i) => 30 + i), fnv1a(Array.from({ length: 30 }, (_, i) => "d" + (30 + i)).join(",")));
  await p.goto(`${base}/index.html?color=d4&d=${encodeURIComponent("survivor~d4:s")}&sel=${sel3060}`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  s = await st();
  const keyName = await p.evaluate(() => (document.querySelector('[data-menu="bar:color"]') as HTMLElement)?.textContent?.trim());
  ok(s.derived === 1 && s.color === "d4" && !!keyName?.includes("≈ survivor"), `a derived dim restores under the KEY the URL names (color=d4 → "≈ survivor") — color=${s.color} label="${keyName}"`);
  // honesty guards: legacy spelled-out ids still resolve; unresolvable ids and a checksum that disagrees
  // with this corpus (same indices, different cards) drop the axis instead of faking one
  await p.goto(`${base}/index.html?d=ghost~nosuch1,nosuch2`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  ok((await st()).derived === 0, "a d= whose example ids don't resolve drops cleanly instead of faking an axis");
  const badSum = "*" + encodeIdxSet(Array.from({ length: 30 }, (_, i) => 30 + i), fnv1a("some,other,corpus"));
  await p.goto(`${base}/index.html?sel=${badSum}&d=${encodeURIComponent("impostor~d0:" + badSum)}`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  s = await st();
  ok(s.selection === 0 && s.derived === 0, `an encoded set whose checksum names a DIFFERENT corpus drops whole (no plausible-looking wrong set) — sel=${s.selection} derived=${s.derived}`);

  // back to a held selection for the rest of the SELECT walk
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(500);
  await p.keyboard.press("s"); await p.waitForTimeout(150);
  await p.evaluate((path) => (window as any).__eidoLasso(path), Array.from({ length: 32 }, (_, a) => { const t = (a / 32) * Math.PI * 2; return [bx + rad * Math.cos(t), by + rad * Math.sin(t)]; }));
  await p.waitForTimeout(300);
  ok((await st()).selection === 30, "the clump is held again for the filter walk");

  // 14d. FILTER TO THESE: the selection becomes a Filter, so it flows through the normal mask + chips row
  await p.click('[data-testid="sel-filter"]'); await p.waitForTimeout(350);
  s = await st();
  ok(s.filters.includes("selection (30)"), `filter-to-these lands in the chips row — filters=${JSON.stringify(s.filters)}`);
  ok(s.visible === 30, `…and hides everything else — visible=${s.visible}/90`);
  ok(s.selection === 0, "…and the selection is consumed by the filter (one state, not two)");
  // it COMPOSES: intersect the set filter with a text filter and the mask narrows further
  await p.locator('input[aria-label="find a card"]').first().fill("Doc 1.1");
  await p.waitForTimeout(300);
  s = await st();
  ok(s.filters.length === 2 && s.visible > 0 && s.visible < 30, `a set filter INTERSECTS with the others — filters=${JSON.stringify(s.filters)} visible=${s.visible}`);

  // 14e. clear, then re-select and clear via the pane's own verb
  await btn(/^reset view$/).click(); await p.waitForTimeout(300);
  s = await st();
  ok(s.filters.length === 0 && s.visible === 90 && s.selectMode === false, `reset clears the set filter AND leaves select mode — ${JSON.stringify({ f: s.filters.length, v: s.visible, sm: s.selectMode })}`);
  const circle = (cx0: number, cy0: number, r: number) => Array.from({ length: 32 }, (_, a) => { const t = (a / 32) * Math.PI * 2; return [cx0 + r * Math.cos(t), cy0 + r * Math.sin(t)]; });
  await p.evaluate((path) => (window as any).__eidoLasso(path), circle(bx, by, rad));
  await p.waitForTimeout(250);
  ok((await st()).selection === 30, "re-selecting the same clump holds it again");
  await p.click('[data-testid="sel-clear"]'); await p.waitForTimeout(250);
  ok((await st()).selection === 0, "the pane's `clear` verb releases the selection");

  // 14f. a SELECTION is shareable: sel=<ids> round-trips through a reload
  await p.evaluate((path) => (window as any).__eidoLasso(path), circle(bx, by, rad));
  await p.waitForTimeout(300);
  const shareUrl = p.url();
  const shareSel = new URL(shareUrl).searchParams.get("sel");
  ok(!!shareSel && (resolveIdSet(parseIdSet(shareSel)!, synthIds)?.length ?? 0) === 30, "a held selection serializes to the URL as a compact encoded set");
  await p.goto(shareUrl);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  s = await st();
  ok(s.selection === 30, `?sel= restores the held selection on load — got ${s.selection}`);
  // ids that no longer exist are DROPPED, not faked
  await p.goto(`${base}/index.html?sel=d30,d31,nosuchcard`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  ok((await st()).selection === 2, `?sel= drops ids the corpus doesn't have — got ${(await st()).selection}`);

  // 14g. THE 3D BEHIND-CAMERA GUARD. Dive into the orbit cloud until part of it sits behind the eye. A
  // perspective projection MIRRORS those points onto the screen, so a naive polygon test would sweep them
  // into the loop. The lasso rejects any point whose NDC z leaves [-1, 1]; this asserts the exact identity:
  // whole-viewport lasso == the cards that are on-screen AND in front, with the mirrored ones excluded.
  await p.goto(`${base}/index.html?layout=orbit`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click().catch(() => {});
  await p.waitForTimeout(300);
  const [ox, oy] = await proj([0, 0]);
  await p.mouse.move(ox, oy);
  await p.mouse.down(); await p.mouse.move(ox + 150, oy + 90, { steps: 12 }); await p.mouse.up();  // orbit off-axis
  await p.waitForTimeout(500);
  await p.mouse.move(ox, oy);
  const depthOf = () => p.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight;
    let front = 0, mirrored = 0;
    for (let i = 0; i < 90; i++) {
      const q = (window as any).__eidoProjectIndex(i); if (!q) continue;
      const on = q[0] >= 0 && q[0] <= W && q[1] >= 0 && q[1] <= H;
      if (q[2] >= -1 && q[2] <= 1) { if (on) front++; } else if (on) mirrored++;   // ndc z out of [-1,1] = behind the eye
    }
    return { front, mirrored };
  });
  const vp = p.viewportSize()!;
  const whole = [[2, 2], [vp.width - 2, 2], [vp.width - 2, vp.height - 2], [2, vp.height - 2]];
  const sweep = () => p.evaluate((path) => (window as any).__eidoLasso(path), whole);
  await p.keyboard.press("s"); await p.waitForTimeout(150);
  // (i) at a normal 3D distance the lasso works like it does in 2D — every visible card, no clipping surprises
  const shallow = await depthOf(), shallowCaught = await sweep();
  ok(shallow.mirrored === 0 && shallowCaught === shallow.front && shallowCaught > 0, `a whole-viewport 3D lasso takes every visible card — caught=${shallowCaught} front=${shallow.front}`);
  await p.click('[data-testid="sel-clear"]'); await p.waitForTimeout(250);
  await p.mouse.move(ox, oy);   // the wheel targets whatever is under the cursor — put it back over the map
  // (ii) …then DIVE into the depth column until part of the cloud sits behind the eye. Those cards still
  // project on-screen (perspective mirrors w<0 through the origin), so a naive polygon test would sweep
  // them in. The guard rejects them: the lasso's catch stays exactly the in-front set.
  for (let i = 0; i < 14; i++) { await p.mouse.wheel(0, -170); await p.waitForTimeout(25); }
  await p.waitForTimeout(500);
  const deep = await depthOf(), deepCaught = await sweep();
  ok(deep.mirrored > 0, `diving the 3D camera really does mirror behind-the-eye cards onto the screen — ${deep.mirrored} of them`);
  // NOTE the shape of this assertion: at this depth the whole cloud is either off-screen or behind the eye,
  // so a lasso over the ENTIRE viewport must come back with exactly the in-front set — and every one of the
  // ${deep.mirrored} mirrored cards is refused even though its pixel is inside the loop. That the guard is
  // what does the refusing (rather than the lasso simply selecting nothing) is pinned in test/lasso.test.ts,
  // where the same call with clipZ off DOES take the mirrored point.
  ok(deepCaught === deep.front, `the 3D lasso takes ONLY what is in front of the camera — caught=${deepCaught}, in-front-on-screen=${deep.front}, behind-but-on-screen and correctly REJECTED=${deep.mirrored}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);

  // 14h. MOBILE (375px): the mode is reachable from the controls sheet, one finger draws the lasso, and
  // two-finger PINCH-ZOOM still works while in the mode (deck registers PINCH independently of drag).
  const mp = await browser.newPage({ viewport: { width: 375, height: 780 }, hasTouch: true, isMobile: true });
  const mst = () => mp.evaluate(() => (window as any).__eido());
  await mp.goto(`${base}/index.html`);
  await mp.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await mp.locator("button", { hasText: /explore/i }).first().click().catch(() => {});
  await mp.waitForTimeout(300);
  await mp.click('[data-menu="sheet:open"]'); await mp.waitForTimeout(300);
  await mp.click('[data-testid="sheet:select"]'); await mp.waitForTimeout(200);
  // click the backdrop's TOP corner — the bottom sheet grew (naming pass added rows) and now covers the
  // element's center, which playwright refuses as an intercepted click
  await mp.locator('button[aria-label="close controls"]').click({ position: { x: 10, y: 10 } }); await mp.waitForTimeout(300);
  ok((await mst()).selectMode === true, "mobile: select mode is reachable from the controls sheet");
  const mcdp = await mp.context().newCDPSession(mp);
  const mtouch = (type: string, pts: { x: number; y: number; id: number }[]) => mcdp.send("Input.dispatchTouchEvent", { type: type as any, touchPoints: pts as any });
  const mbox = (await mp.locator("canvas").boundingBox())!;
  // draw around the ORIGIN blob, well clear of the bottom sheet the pane will occupy
  const [mfx, mfy] = await mp.evaluate(() => (window as any).__eidoProject([0, 0]) as number[]);
  await mtouch("touchStart", [{ x: mfx + 60, y: mfy, id: 1 }]);
  for (let a = 1; a <= 28; a++) { const t = (a / 28) * Math.PI * 2; await mtouch("touchMove", [{ x: mfx + 60 * Math.cos(t), y: mfy + 60 * Math.sin(t), id: 1 }]); }
  await mtouch("touchEnd", []);
  await mp.waitForTimeout(400);
  const msel = (await mst()).selection;
  ok(msel > 0, `mobile: a ONE-FINGER drag draws the lasso and holds a set — ${msel} cards`);
  // pinch ABOVE the pane (on a phone the reading pane is a bottom sheet — it owns the lower screen)
  const mz0 = (await mst()).zoom;
  const py0 = mbox.y + mbox.height * 0.12;
  await mtouch("touchStart", [{ x: mfx - 45, y: py0, id: 1 }, { x: mfx + 45, y: py0, id: 2 }]);
  for (let k = 1; k <= 16; k++) { await mtouch("touchMove", [{ x: mfx - 45 - k * 7, y: py0, id: 1 }, { x: mfx + 45 + k * 7, y: py0, id: 2 }]); await mp.waitForTimeout(15); }
  await mtouch("touchEnd", []);
  await mp.waitForTimeout(500);
  const mz1 = (await mst()).zoom;
  ok(mz1 > mz0 + 0.1, `mobile: two-finger pinch still ZOOMS while in select mode — ${mz0.toFixed(2)}→${mz1.toFixed(2)}`);
  ok((await mst()).selectMode === true, "mobile: pinching does not knock you out of select mode");

  // 14i. ANIMATION (eid-aw7x): a camera FIT under mobile emulation EASES — interpolated intermediate
  // frames, not a jump. Mobile emulation sends prefers-reduced-motion: no-preference, exactly what a
  // default real phone sends (verified on the iOS simulator); with the OS setting on, motion is
  // deliberately brief (deckmap.ts dur()). Headless can prove frames exist; feel needs a real phone.
  ok(await mp.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches), "mobile emulation sends reduced-motion: no-preference (the default-phone contract)");
  // displace the camera first (pinch IN well past the fit frame) so the fit has real distance to travel
  await mtouch("touchStart", [{ x: mfx - 20, y: py0, id: 1 }, { x: mfx + 20, y: py0, id: 2 }]);
  for (let k = 1; k <= 20; k++) { await mtouch("touchMove", [{ x: mfx - 20 - k * 7, y: py0, id: 1 }, { x: mfx + 20 + k * 7, y: py0, id: 2 }]); await mp.waitForTimeout(15); }
  await mtouch("touchEnd", []);
  await mp.waitForTimeout(500);
  // record the camera TARGET per frame (a small selection's fit zoom rides the maxZoom clamp, so the
  // observable interpolation is the pan) — intermediate frames = the transition really ran.
  await mp.evaluate(() => { const rec: number[] = []; (window as any).__rec = rec; const t0 = performance.now(); const loop = () => { rec.push(((window as any).__eido().target ?? [NaN, NaN])[1]); if (performance.now() - t0 < 1400) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  await mp.click('[data-testid="sel-fit"]');  // frame the held selection — the explicit camera move
  await mp.waitForTimeout(1500);
  const ys = (await mp.evaluate(() => (window as any).__rec as number[])).filter((y) => Number.isFinite(y));
  const yA = ys[0], yB = ys[ys.length - 1];
  const yMid = new Set(ys.filter((y) => Math.abs(y - yA) > 1e-4 && Math.abs(y - yB) > 1e-4).map((y) => y.toFixed(4)));
  ok(Math.abs(yB - yA) > 0.05 && yMid.size >= 4, `mobile: camera fit EASES, not jumps — ${yMid.size} distinct intermediate camera frames across targetY ${yA?.toFixed(2)}→${yB?.toFixed(2)} (eid-aw7x)`);
  await mp.close();

  ok(consoleErrs.length === 0, "no console errors during the run" + (consoleErrs.length ? " — " + consoleErrs[0] : ""));
} finally {
  await browser.close();
  server.stop(true);
}

console.log(fails.length ? `\n✗ ${fails.length} E2E assertion(s) failed` : `\n✅ new-viewer E2E passed`);
process.exit(fails.length ? 1 : 0);
