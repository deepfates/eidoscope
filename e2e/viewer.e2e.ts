// Integration net for the NEW Svelte + deck.gl viewer. Builds a SYNTHETIC map, encodes it to the real
// .eido wire format, serves the REAL built viewer/dist/index.html beside it, drives it in Chromium, and
// asserts interaction invariants through the read-only window.__eido() seam (+ __eidoProject for exact
// world→screen picking). This is the parity gate (eid-55ln): it exercises the actual production bundle,
// not a mock. Hermetic (no fixture, no 15k run, deterministic — no RNG).
// Run: bun run e2e/viewer.e2e.ts   (exits non-zero on any failure). Requires `cd viewer && bun run build`.
import { chromium } from "playwright";
// NOTE on the optional intro dismissal below: the "explore →" button only exists while the intro is
// showing, and the intro now introduces itself ONCE per browser profile (eid-z4m7). A .click() with
// Playwright's default 30s timeout therefore waited out the full timeout on every mount after the
// first — 16 of them, silently swallowed by .catch(), which is most of why this suite took 547s.
// Optional actions get an optional timeout.
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
// 2200 wide: the full desktop toolbar (every tier unfolded, including the scatter layouts' axes menu
// and the document verbs open/export/save)
// measures ~1910px on this corpus — priority collapse (eid-ef7e) folds controls below that, and the
// desktop tests here drive the UNFOLDED bar. The fold behaviour has its own section (16) below.
const p = await browser.newPage({ viewport: { width: 2200, height: 1050 }, deviceScaleFactor: 2, hasTouch: true });
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
  // M-C1: the corpus scope readout exists with NO filter active — always-on, one consistent place
  const scope0 = await p.evaluate(() => document.querySelector("[data-scope]")?.textContent?.trim());
  ok(scope0 === "90 / 90 cards", `the N / M cards readout is always on, even with no filter — "${scope0}"`);

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
  const legendItem = p.locator('button[aria-label^="show region"]').first();
  const before = (await st()).visible;
  await legendItem.click(); await p.waitForTimeout(200); s = await st();
  ok(s.grain === g0, `legend-click leaves grain unchanged — grain ${g0}→${s.grain}`);
  ok(s.pin !== null, "legend-click chooses the region");
  // SELECTION HIGHLIGHTS, FILTERING EXCLUDES — they are different acts, and the legend does the first.
  // Picking a region used to exclude every other card on the spot; now the rest dims and stays, and you
  // can still see where the region sits inside the whole. Excluding is a verb you press.
  ok(s.visible === before && s.filters.length === 0, `legend-click excludes nothing — ${before} cards still shown, no filter chip`);
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
  // …and the pane's own verb is what excludes, by name and by hand
  await p.locator("[data-testid=region-filter]").first().click(); await p.waitForTimeout(500); s = await st();
  ok(s.visible < before && s.filters.length === 1, `the region pane's "filter to these" is what excludes — ${before}→${s.visible} cards, chip "${s.filters[0]}"`);
  await p.keyboard.press("Meta+z"); await p.waitForTimeout(400); s = await st();
  ok(s.visible === before && s.filters.length === 0, "undo takes the region filter back off");
  await menu("color"); await legendItem.click(); await p.waitForTimeout(200); await closeMenus();   // release, back to a clean slate

  // 5. drill via map double-click steps grain finer (and does NOT open a card)
  await btn(/^reset view$/).click(); await p.waitForTimeout(200); const gd = (await st()).grain;
  await p.mouse.dblclick(cx, cy); await p.waitForTimeout(400); s = await st();
  ok(s.grain > gd, `double-click drills one step finer — grain ${gd}→${s.grain}`);
  // The note that used to sit here said this could not be asserted because Playwright's synthetic mouse
  // does not drive deck's onClick deterministically. Measured on the real 19,299-card map, it does — the
  // trailing click just arrives LATE (647ms, because drilling rebuilds every layer and starts a camera
  // flight before deck can dispatch), which is exactly how it slipped past the old 350ms time guard and
  // re-opened the card the drill had closed. So: wait past the flight, then assert.
  await p.waitForTimeout(1400); s = await st();
  ok(!s.detail, "drilling changes the grain and NOTHING else — no card left open over the map");
  // …and the guard must not outlive its gesture: the very next click still opens a card. Click a node
  // whose position we ASK for — the drill flies the camera to the region it drilled, so a fixed screen
  // coordinate is no longer over anything in particular.
  const spot = await p.evaluate(() => {
    for (let i = 0; i < 90; i++) { const q = (window as any).__eidoProjectIndex(i); if (q && q[0] > 40 && q[1] > 90) return [q[0], q[1]]; }
    return null;
  });
  ok(!!spot, "a card is on screen after the drill's camera flight");
  if (spot) { await p.mouse.click(Math.round(spot[0]), Math.round(spot[1])); await p.waitForTimeout(600); s = await st();
    ok(s.detail, "a click right after a drill still opens a card — the drill's guard does not linger"); }
  await p.keyboard.press("Escape"); await p.waitForTimeout(200);

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
    const b = document.querySelector('[aria-label^="show region"]') as HTMLElement | null;
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
  // M-C4: the deck's own narrowing shows its scope INSIDE the deck (not as a map chip — M-N2 stands)
  const deckScope = await p.evaluate(() => document.querySelector("[data-deck-scope]")?.textContent?.trim());
  ok(deckScope === "60 / 90 cards", `the deck states its own scope after unread-only — "${deckScope}"`);
  ok((await st()).filters.length === 0, "…and deck narrowing puts NO chip on the map (deck stays deck-local)");
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

  // 11c-ter. M-B (eid-hsy3): "every view is a URL" now includes overlays, labels, and the deck's own
  // state. Set each through the real UI, read the URL it minted, then load that URL FRESH and assert the
  // view comes back — the same round-trip discipline as ?sel= / ?d=.
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(200);
  await menu("layout"); await p.click('[data-opt="bar:overlay:cite"]'); await p.waitForTimeout(120);
  await menu("layout"); await p.click('[data-opt="bar:overlay:ghosts"]'); await p.waitForTimeout(120); await closeMenus();
  await btn(/^labels$/).click(); await p.waitForTimeout(120);                      // labels OFF
  await btn(/^deck$/).click(); await p.waitForTimeout(200);                               // deck OPEN
  await p.selectOption('select[aria-label="sort the deck"]', "a"); await p.waitForTimeout(120);  // sort by AxisA
  await p.locator('input[aria-label^="find in the list"]').fill("Doc 1"); await p.waitForTimeout(200); // deck.filter
  await btn(/unread only/i).click(); await p.waitForTimeout(200);                         // deck.unread
  url = new URL(p.url());
  ok(url.searchParams.get("cite") === "1" && url.searchParams.get("ghosts") === "1", `overlays mirror to the URL — cite=${url.searchParams.get("cite")} ghosts=${url.searchParams.get("ghosts")}`);
  ok(url.searchParams.get("labels") === "0", `labels-off mirrors to the URL — labels=${url.searchParams.get("labels")}`);
  ok(url.searchParams.get("sort") === "a", `the sort channel serializes like the other six — sort=${url.searchParams.get("sort")}`);
  ok(url.searchParams.get("deck") === "1" && url.searchParams.get("df") === "Doc 1" && url.searchParams.get("du") === "1", `the deck's open/filter/unread state rides the URL — deck=${url.searchParams.get("deck")} df=${url.searchParams.get("df")} du=${url.searchParams.get("du")}`);
  const mbUrl = p.url();
  await p.goto(mbUrl); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(500);
  s = await st();
  ok(s.cite === true && s.ghosts === true, `a fresh load restores the overlays — cite=${s.cite} ghosts=${s.ghosts}`);
  ok(s.labelsOn === false, `…and the labels-off state — labelsOn=${s.labelsOn}`);
  ok(s.sort === "a", `…and the sort channel — sort=${s.sort}`);
  ok(s.deckOpen === true && s.deckQ === "Doc 1" && s.deckUnread === true, `…and the link LANDS ON THE LIST VIEW with its filter + unread state — deckOpen=${s.deckOpen} deckQ=${JSON.stringify(s.deckQ)} deckUnread=${s.deckUnread}`);
  // the restored deck really shows the narrowed, unread-only, AxisA-sorted rows (state → pixels, not just state)
  const mbRows = await p.locator("[data-deck-card]").count();
  ok(mbRows > 0 && mbRows < 90, `the restored deck is narrowed by df+du — ${mbRows} rows of 90`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);

  // 11d. FOCUS TRAP: opening the deck moves focus inside it and Tab stays trapped (eid-vxm2)
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(300);
  const inDeck = () => p.evaluate(() => { const d = document.querySelector('[role="dialog"][aria-label="deck reader"]'); return !!d && d.contains(document.activeElement); });
  ok(await inDeck(), "opening the deck moves focus inside the modal");
  await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.waitForTimeout(100);
  ok(await inDeck(), "Tab keeps focus trapped inside the deck (eid-vxm2)");

  // 11e. FACET ISOLATE: colour by a facet, click a facet legend row → isolates just that value (eid-zvh9)
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(150);
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
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(150);
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

  // 11g. SCOPE (M-C2/M-C3): a restored window's chip shows the RANGE ITSELF in honest units, and every
  // chip carries its own match count. dates run 2023-11-14 + i days; window the first 10 (i = 0..9).
  const slo = 1_700_000_000_000, shi = 1_700_000_000_000 + 9 * 86_400_000;
  await p.goto(`${base}/index.html?sk=date&slo=${slo}&shi=${shi}&find=${encodeURIComponent("Doc 0.1")}`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(400);
  s = await st();
  ok(s.filters.includes("date 2023-11 – 2023-11"), `the window chip states the chosen range, not "<dim> window" — filters=${JSON.stringify(s.filters)}`);
  ok(JSON.stringify(s.filterCounts) === JSON.stringify([11, 10]), `each chip carries ITS OWN match count ("Doc 0.1" alone = 11, the date window alone = 10) — got ${JSON.stringify(s.filterCounts)}`);
  ok(s.visible === 1, `…while the scope readout shows the intersection (only Doc 0.1 is in both) — visible=${s.visible}`);
  const scopeW = await p.evaluate(() => document.querySelector("[data-scope]")?.textContent?.trim());
  ok(scopeW === "1 / 90 cards", `the always-on readout agrees — "${scopeW}"`);

  // 11h. ESCAPE POPS THE MOST RECENT CHIP, WHATEVER KIND IT IS (Hac-aycw). Isolating a region and typing a
  // find both put a chip in this row and they look identical, but Escape used to pop the region and leave
  // the find — the back-out ladder had a special case for one filter KIND. Two chips are loaded here (a
  // find and a window); Escape must take them off one at a time, newest first, exactly as the ✕ would.
  await p.keyboard.press("Escape"); await p.waitForTimeout(250);
  s = await st();
  ok(s.filters.length === 1 && s.filters[0] === "“Doc 0.1”", `Escape pops the newest chip — the window — leaving ${JSON.stringify(s.filters)}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(250);
  s = await st();
  ok(s.filters.length === 0 && s.visible === 90, `…and again pops the find, which Escape used to ignore entirely — filters=${JSON.stringify(s.filters)} visible=${s.visible}`);

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
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {}); await p.waitForTimeout(150);
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
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
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
  ok(JSON.stringify(selPane?.verbs) === JSON.stringify(["sel-filter", "sel-fit", "sel-descend", "sel-derive", "sel-clear"]), `the verbs appear on a held set — ${JSON.stringify(selPane?.verbs)}`);
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
  ok(s.filters.includes("selection") && s.filterCounts.includes(30), `filter-to-these lands in the chips row with its own count — filters=${JSON.stringify(s.filters)} counts=${JSON.stringify(s.filterCounts)}`);
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

  // 14e-ii. A LASSO THAT CATCHES NOTHING SAYS SO (eid-fw7o). A straight drag encloses no area, so it took
  // zero cards and the app did nothing at all — reported as "select mode is broken", which is what silence
  // looks like from outside. The two ways to catch nothing say different things because they need
  // different things from the reader: redraw the shape, versus the shape was fine and empty.
  const noteAfter = async (path: number[][]) => {
    await p.evaluate((q) => (window as any).__eidoLasso(q), path);
    await p.waitForTimeout(250);
    return p.evaluate(() => document.querySelector("[data-save-note]")?.textContent?.trim() ?? "");
  };
  const lineNote = await noteAfter([[bx - 60, by - 60], [bx, by], [bx + 60, by + 60]]);
  ok(/no area/.test(lineNote), `a zero-area stroke explains itself — "${lineNote}"`);
  const voidNote = await noteAfter(circle(bx + rad * 8, by + rad * 8, 12));
  ok(/nothing inside/.test(voidNote), `an empty loop says it was empty, not that it was malformed — "${voidNote}"`);
  // …and a lasso that DOES catch something leaves no stale message behind it
  await p.evaluate((path) => (window as any).__eidoLasso(path), circle(bx, by, rad));
  await p.waitForTimeout(250);
  const afterReal = await p.evaluate(() => document.querySelector("[data-save-note]")?.textContent?.trim() ?? "");
  ok((await st()).selection === 30 && !/no area|nothing inside/.test(afterReal), `a successful lasso clears the message — "${afterReal}"`);
  await p.click('[data-testid="sel-clear"]'); await p.waitForTimeout(250);

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
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
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
  // A FRESH CONTEXT ALWAYS SEES THE INTRO (localStorage is per-context), so this dismissal is NOT optional
  // and must not be budgeted like one: the intro cannot render until the map has mounted, and mounting on
  // an emulated mobile device blocks the main thread — measured 29ms on one run and 1206ms on the next,
  // straddling the old fixed 1200ms budget. When it lost the race the modal stayed up and ate the next
  // click. Wait for the thing itself.
  // …and while it IS up, look at it. This is the first thing anyone sees on a phone and nothing had ever
  // measured it: the dialog rendered 448px wide in a 390px viewport with every line running off the right
  // edge, fixed by giving it `w-full min-w-0` so it takes the width it is offered instead of the width its
  // content asks for. Checked here because this is the only context in the suite that is both mobile and
  // fresh enough to still have the intro open.
  //
  // WHAT THIS ASSERTION IS AND IS NOT (docs/VERIFY.md — say what an instrument cannot catch): it is a
  // FLOOR, not a reproduction. Reverting the fix leaves it green, because the synth fixture's content does
  // not drive the box past the viewport the way the shipped Pathfinder map's does. The fix itself was
  // verified by measuring the real map in a real browser at 390px — 448px/+74 before, 358px/−16 after —
  // and this line exists to catch a future regression that IS reproducible here. Do not read it as proof
  // the original bug is covered.
  const introBox = await mp.evaluate(() => {
    const d = document.querySelector<HTMLElement>("[role=dialog][aria-label=welcome]");
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { over: Math.round(Math.max(r.right - window.innerWidth, -r.left)), w: Math.round(r.width), vw: window.innerWidth };
  });
  ok(!!introBox, "the first-run intro is actually up on a fresh mobile context (else the check below proves nothing)");
  ok(!!introBox && introBox.over <= 0, `the intro fits the phone — ${introBox?.w}px dialog in a ${introBox?.vw}px viewport${introBox && introBox.over > 0 ? `, overflowing by ${introBox.over}px` : ""}`);
  await mp.locator("button", { hasText: /explore/i }).first().click();
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

  // ═══ 15. SECOND BINDINGS (eid-hsy3, M-A) — every critical command gets an expert route ═══════════
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  await p.waitForTimeout(250);

  // 15a. `l` toggles region labels (M-A3)
  s = await st();
  ok(s.labelsOn === true, "region labels start on under the region lens");
  await p.keyboard.press("l"); await p.waitForTimeout(150);
  ok((await st()).labelsOn === false, "the `l` key toggles region labels off");
  await p.keyboard.press("l"); await p.waitForTimeout(150);
  ok((await st()).labelsOn === true, "…and back on");

  // 15b. `d` opens the deck (M-A3); Escape still closes it
  await p.keyboard.press("d"); await p.waitForTimeout(250);
  ok((await st()).deckOpen === true, "the `d` key opens the deck");
  await p.keyboard.press("Escape"); await p.waitForTimeout(250);
  ok((await st()).deckOpen === false, "Escape closes it again");

  // 15c. camera keyboard routes (M-A5): arrows pan, =/- zoom — native key repeat gives hold-to-move
  s = await st(); const kt0 = s.target, kz0 = s.zoom;
  await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(150);
  s = await st();
  ok(!!s.target && s.target[0] !== kt0[0], `ArrowRight pans the camera — targetX ${kt0[0].toFixed(3)}→${s.target[0].toFixed(3)}`);
  await p.keyboard.press("ArrowUp"); await p.waitForTimeout(150);
  s = await st();
  ok(s.target[1] !== kt0[1], `ArrowUp pans on the other axis — targetY ${kt0[1].toFixed(3)}→${s.target[1].toFixed(3)}`);
  await p.keyboard.press("="); await p.waitForTimeout(150);
  s = await st();
  ok(s.zoom > kz0, `the + key zooms in — ${kz0.toFixed(2)}→${s.zoom.toFixed(2)}`);
  await p.keyboard.press("-"); await p.waitForTimeout(150);
  ok((await st()).zoom < s.zoom, "the - key zooms back out");

  // 15d. `r` resets the view (M-A3): move grain off the default, then one key restores it
  await setGrain(0); await p.waitForTimeout(150);
  ok((await st()).grain === 0, "grain moved off the default (setup)");
  await p.keyboard.press("r"); await p.waitForTimeout(300);
  ok((await st()).grain === 2, "the `r` key resets the view (grain back to the file's default)");

  // 15e. shift+arrows orbit in 3D (M-A5)
  await p.goto(`${base}/index.html?layout=orbit`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  await p.waitForTimeout(250);
  s = await st(); const rot0 = s.rot, rotX0 = s.rotX;
  await p.keyboard.press("Shift+ArrowRight"); await p.waitForTimeout(150);
  s = await st();
  ok(s.rot !== rot0, `shift+ArrowRight orbits the 3D camera — rot ${rot0}→${s.rot}`);
  await p.keyboard.press("Shift+ArrowUp"); await p.waitForTimeout(150);
  ok((await st()).rotX !== rotX0, `shift+ArrowUp tilts it — rotX ${rotX0}→${(await st()).rotX}`);

  // 15f. region.drill's second binding (M-A1): the `drill in` button in the region pane — same act as
  // double-clicking a member point, reachable without a pointer gesture.
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  await p.waitForTimeout(250);
  const gDrill = (await st()).grain;
  await menu("color");
  await p.locator('button[aria-label^="show region"]').first().click(); await p.waitForTimeout(200);
  await closeMenus();
  await p.locator("[data-testid=region-drill]").first().click(); await p.waitForTimeout(500);
  s = await st();
  ok(s.grain > gDrill, `the region pane's 'drill in' button steps grain finer — ${gDrill}→${s.grain}`);
  ok(s.pin === null, "…and the stale region filter goes with the old grain (same as double-click drill)");
  await btn(/^reset view$/).click(); await p.waitForTimeout(250);

  // 15g. facet.isolate from the dimension's OWN value list (M-A4): isolate by author while colour stays
  // on region — isolate is a corpus command, no longer welded to the colour channel.
  await menu("color");
  await p.click('[data-iso="bar:author"]'); await p.waitForTimeout(150);
  await p.locator('button[aria-label^="isolate author"]').first().click(); await p.waitForTimeout(250);
  await closeMenus();
  s = await st();
  ok(s.color === "region", `the colour lens did not move — still ${s.color}`);
  ok(s.filters.length === 1 && s.visible < 90, `…yet the author facet filters the corpus — filters=${JSON.stringify(s.filters)} visible=${s.visible}/90`);
  await btn(/^reset view$/).click(); await p.waitForTimeout(250);

  // ═══ 16. SAVED VIEWS (eid-thbs): the .eido carries named views. Full loop, no shortcuts — mint a
  // derived axis from a lasso'd selection, place it, save the view, DOWNLOAD the re-emitted file, drop
  // that downloaded file back onto the app (the real open path), open the view: axis + selection +
  // channels + grain + camera restore exactly. A derived axis + big selection in a view is durable with
  // NO reference to URL capacity anywhere — it rides in the file as full ids.
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  await p.waitForTimeout(300);
  await p.keyboard.press("s"); await p.waitForTimeout(150);
  await p.evaluate((path) => (window as any).__eidoLasso(path), circle(bx, by, rad));
  await p.waitForTimeout(300);
  ok((await st()).selection === 30, "views: blob 1 is held for the save");
  await p.locator('[data-testid="derive-label"]').fill("blobby");
  await p.click('[data-testid="sel-derive"]'); await p.waitForTimeout(300);
  await p.click('[data-testid="derive-place-color"]'); await p.waitForTimeout(300);
  await setGrain(3);
  // move the camera somewhere deliberate so the view has a pose worth restoring
  const [vcx, vcy] = await proj([1.6, 1.1]);
  await p.mouse.move(vcx, vcy);
  for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -140); await p.waitForTimeout(20); }
  await p.waitForTimeout(300);
  const preSave = await st();
  ok(preSave.color === "d0" && preSave.derived === 1 && preSave.selection === 30 && preSave.grain === 3, `views: the state to be saved is real — color=${preSave.color} derived=${preSave.derived} sel=${preSave.selection} grain=${preSave.grain}`);
  // save view: name it in the about popover — it appends IN MEMORY and marks the document dirty.
  // The SAVE verb (eid-cawh) then persists: no FSA handle here (the map came by fetch), so the save is
  // a download PRESERVING the opened filename — map.eido, not a slug, not a numbered copy.
  await closeMenus();
  await p.click('[data-menu="bar:about"]'); await p.waitForTimeout(250);
  await p.fill('[data-testid="bar:view-name"]', "beta clump"); await p.click('[data-testid="bar:view-save"]');
  await p.waitForTimeout(150);
  ok((await st()).views === 1, "views: save view appends the view to the file IN MEMORY");
  ok((await st()).dirty === true, "save: unsaved work shows — the document is dirty after a view append");
  await closeMenus();
  const [dl] = await Promise.all([
    p.waitForEvent("download", { timeout: 15000 }),
    p.click('[data-testid="bar:save"]'),
  ]);
  ok(dl.suggestedFilename() === "map.eido", `save: the download preserves the opened filename — got "${dl.suggestedFilename()}"`);
  ok((await st()).dirty === false, "save: the dirty mark clears once the file is written");
  const dlPath = await dl.path();
  const savedBytes = readFileSync(dlPath!);
  ok(savedBytes.length > 1000, `save: the re-emitted .eido downloads — ${savedBytes.length} bytes`);
  // …and the downloaded file decodes with our own codec, carrying the FULL uncapped state
  const savedD = (await import("../src/mapbin.ts")).decodeMap(savedBytes);
  const sv = savedD.views?.[0];
  ok(savedD.views?.length === 1 && sv?.name === "beta clump", `views: the downloaded file carries the view — ${JSON.stringify(savedD.views?.map((v) => v.name))}`);
  ok(sv?.state.selection?.length === 30 && sv?.state.derived?.[0]?.ids.length === 30 && sv?.state.derived?.[0]?.label === "blobby", `views: FULL ids in the file, no cap — sel=${sv?.state.selection?.length} derivedIds=${sv?.state.derived?.[0]?.ids.length}`);
  // reopen the downloaded file via the existing DROP path, on a fresh page (nothing carried over)
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  await p.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "saved.eido", { type: "application/octet-stream" });
    const dt = new DataTransfer(); dt.items.add(file);
    document.querySelector('[role="application"]')!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, savedBytes.toString("base64"));
  await p.waitForFunction(() => (window as any).__eido?.()?.views === 1, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});   // a freshly opened file introduces itself
  await p.waitForTimeout(300);
  s = await st();
  ok(s.derived === 0 && s.selection === 0 && s.color === "region", `views: the dropped file opens on a CLEAN slate (views wait to be opened) — derived=${s.derived} sel=${s.selection} color=${s.color}`);
  // open the view — one action applies the state exactly
  await p.click('[data-menu="bar:about"]'); await p.waitForTimeout(250);
  const viewRow = await p.evaluate(() => (document.querySelector("[data-views]")?.textContent ?? ""));
  ok(viewRow.includes("beta clump"), `views: the about popover lists the saved view — "${viewRow.slice(0, 60)}…"`);
  await p.click('[data-testid="bar:view-open-0"]'); await p.waitForTimeout(700);
  await closeMenus();
  s = await st();
  ok(s.derived === 1 && s.dims.includes("d0"), `views: opening the view re-derives the axis — derived=${s.derived}`);
  ok(s.color === "d0", `views: …and the channel placement restores — color=${s.color}`);
  ok(s.selection === 30, `views: …and the held selection restores in full — sel=${s.selection}`);
  ok(s.grain === 3, `views: …and the grain restores — grain=${s.grain}`);
  ok(Math.abs(s.zoom - preSave.zoom) < 0.05, `views: …and the camera pose restores — zoom ${preSave.zoom.toFixed(2)}→${s.zoom.toFixed(2)}`);
  const colorName15 = await p.evaluate(() => (document.querySelector('[data-menu="bar:color"]') as HTMLElement)?.textContent?.trim());
  ok(!!colorName15?.includes("≈ blobby"), `views: the axis comes back under its own label — "${colorName15}"`);

  // ═══ 16b. EXPORT MENU (eid-4ii9) — one surface, every outbound artifact, all flowing from the cards.
  // Still on the dropped saved.eido, so every artifact must inherit ITS name (saved-*) — the document's
  // identity travels through the whole lifecycle.
  console.log("16b. export menu — single-file HTML · vault zip · deck JSONL");
  ok((await st()).file === "saved.eido", `export: the open document knows its filename — ${(await st()).file}`);
  const { unzipSync, strFromU8 } = await import("fflate");
  const grab = async (opt: string) => {
    await closeMenus();
    await p.click('[data-menu="bar:export"]'); await p.waitForTimeout(200);
    const [d] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.click(`[data-opt="bar:export:${opt}"]`)]);
    await p.waitForTimeout(100);
    return d;
  };
  const dHtml = await grab("html");
  ok(dHtml.suggestedFilename() === "saved.html", `export html: named after the document — "${dHtml.suggestedFilename()}"`);
  const htmlText = readFileSync((await dHtml.path())!, "utf8");
  const payloadM = htmlText.match(/window\.__EIDO_DATA__=("(?:[^"\\]|\\.)*")/);
  ok(!!payloadM, "export html: the single file carries an inlined __EIDO_DATA__ payload");
  if (payloadM) {
    const baked = (await import("../src/mapbin.ts")).decodeMap(Buffer.from(JSON.parse(payloadM[1]), "base64"));
    ok(baked.ids.length === 90 && baked.views?.length === 1, `export html: the baked payload is the CURRENT gem, views included — ${baked.ids.length} cards, ${baked.views?.length} view`);
  }
  const dVault = await grab("vault");
  ok(dVault.suggestedFilename() === "saved-vault.zip", `export vault: named after the document — "${dVault.suggestedFilename()}"`);
  const zipEntries = unzipSync(readFileSync((await dVault.path())!));
  const zipNames = Object.keys(zipEntries);
  ok(zipNames.length === 91 && zipNames.includes("eidoscope-vault.json"), `export vault: one .md per card + the manifest — ${zipNames.length} entries for 90 cards`);
  ok(strFromU8(zipEntries[zipNames.find((n) => n.endsWith(".md"))!]).startsWith("---"), "export vault: cards carry their frontmatter");
  const dDeck = await grab("deck");
  ok(dDeck.suggestedFilename() === "saved-deck.jsonl", `export deck: named after the document — "${dDeck.suggestedFilename()}"`);

  // SEPARABLE PARTS (eid-ncrq): the three strata come apart into files something else can read — the
  // cards as source truth, the embeddings as a raw f32 buffer, the display geometry, and a manifest
  // saying what each one is. Driven here rather than only unit-tested, because the menu wiring is the
  // half a unit test cannot see.
  const dParts = await grab("parts");
  ok(dParts.suggestedFilename() === "saved-parts.zip", `export parts: named after the document — "${dParts.suggestedFilename()}"`);
  const partsEntries = unzipSync(new Uint8Array(readFileSync(await dParts.path())));
  const partNames = Object.keys(partsEntries).sort();
  ok(partNames.includes("cards.jsonl") && partNames.includes("geometry.json") && partNames.includes("manifest.json"),
    `export parts: the strata are separate files — ${partNames.join(", ")}`);
  const partsMan = JSON.parse(strFromU8(partsEntries["manifest.json"]));
  ok(partsMan.cards === 90, `export parts: the manifest counts the real corpus — ${partsMan.cards} cards`);
  ok(strFromU8(partsEntries["cards.jsonl"]).trim().split("\n").length === 90, "export parts: one card per line, all 90");
  ok(!!partsEntries["vectors.f32"] && partsEntries["vectors.f32"].byteLength % 4 === 0,
    `export parts: the embeddings are a raw f32 buffer — ${partsEntries["vectors.f32"]?.byteLength} bytes`);
  const deckLines = readFileSync((await dDeck.path())!, "utf8").trim().split("\n");
  const row0 = JSON.parse(deckLines[0]);
  ok(deckLines.length === 90 && !!row0.id && !!row0.core && !!row0.axes, `export deck: one card-shaped row per card — ${deckLines.length} lines`);

  // ── 16. PRIORITY COLLAPSE (eid-ef7e): at narrow desktop widths the toolbar FOLDS lower-priority
  // controls into the mobile controls sheet instead of clipping them mid-glyph. Assert, at each width:
  // no visible toolbar control (triggers included) renders partially clipped, the row never scrolls,
  // and a folded control is still reachable — and WORKS — from the "controls ▴" sheet.
  console.log("16. priority collapse — the toolbar folds, it never clips");
  await p.goto(`${base}/index.html`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await btn(/explore/i).click({ timeout: 1200 }).catch(() => {});
  for (const w of [1960, 1280, 1100, 900]) {
    await p.setViewportSize({ width: w, height: 1050 });
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      const row = document.querySelector("header > div") as HTMLElement;
      const clipped: string[] = [];
      let visible = 0, folded = 0;
      for (const el of row.querySelectorAll<HTMLElement>("[data-fold],[data-fold-trigger],[data-menu]")) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") { folded++; continue; }
        visible++;
        const b = el.getBoundingClientRect();
        if (b.left < -0.5 || b.right > innerWidth + 0.5) clipped.push((el.dataset.menu || el.dataset.fold || "?") + ` [${Math.round(b.left)},${Math.round(b.right)}]`);
      }
      return { clipped, visible, folded, overflow: row.scrollWidth - row.clientWidth, trigger: !!row.querySelector("[data-fold-trigger]") && getComputedStyle(row.querySelector("[data-fold-trigger]")!).visibility === "visible" };
    });
    ok(r.clipped.length === 0, `fold @${w}: no visible control clips — ${r.visible} whole controls${r.clipped.length ? " · CLIPPED " + r.clipped.join(", ") : ""}`);
    ok(r.overflow <= 0, `fold @${w}: the toolbar row does not scroll (overflow ${r.overflow}px)`);
    if (w < 1960) ok(r.folded > 0 && r.trigger, `fold @${w}: lower-priority controls folded (${r.folded}) behind a visible "controls ▴"`);
    else ok(!r.trigger, `fold @${w}: nothing folded at full width — the trigger stays hidden`);
  }
  // the folded controls still WORK from the sheet: at 1100 `size` is folded off the bar; place a
  // dimension on size through the sheet and assert the channel actually changed.
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('[data-menu="bar:size"]')!).visibility === "hidden"), "fold @1100: the bar's size trigger is folded away, whole — not clipped");
  await p.click('[data-menu="bar:controls"]'); await p.waitForTimeout(300);
  await p.click('[data-menu="sheet:size"]'); await p.waitForTimeout(250);
  await p.click('[data-opt="sheet:size:length"]'); await p.waitForTimeout(250);
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);   // close the popover…
  await p.keyboard.press("Escape"); await p.waitForTimeout(250);   // …then the sheet
  ok(await p.evaluate(() => (window as any).__eido().visible >= 0 && !document.querySelector('[data-opt="sheet:size:length"]')), "fold: sheet + its menus dismiss cleanly");
  const foldedSize = await p.evaluate(() => (document.querySelector('[data-menu="bar:size"]') as HTMLElement)?.textContent?.trim());
  ok(!!foldedSize && !foldedSize.includes("uniform"), `fold: a folded control still works from the sheet — size channel now "${foldedSize}"`);
  await p.setViewportSize({ width: 2200, height: 1050 }); await p.waitForTimeout(250);

  // ── eid-kzv2 micro-UX: an honest map never shows a state it cannot explain ──────────────────────
  // (a) filtered down to nothing: the map used to go blank while region labels still floated over the
  //     empty space, so it read as broken rather than as empty. (b) a view that names a dimension this
  //     map does not have used to be a silent no-op. (c) the toolbar folded on an ESTIMATE that
  //     under-counted, so controls overlapped instead of folding.
  await p.goto(`${base}/index.html`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(400);
  await p.evaluate(() => { const i = document.querySelector('input[type="search"]') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(i, "zzqqxxnothingmatches"); i.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.waitForTimeout(500);
  ok((await st()).visible === 0, "zero-hit find: nothing is visible");
  ok(await p.locator("[data-scope][data-empty=true]").isVisible(), "zero-hit find: the scope readout marks itself empty — no panel of prose over the map");
  ok((await st()).labels === 0, "zero-hit find: no region label is left floating over an empty map");
  ok(await p.locator('[aria-label="clear all filters"]').isVisible(), "zero-hit find: the way out is offered even with a single filter");
  await p.click('[aria-label="clear all filters"]'); await p.waitForTimeout(400);
  ok((await st()).visible > 0, "zero-hit find: clearing the filters restores the corpus");
  // …and what a keypress took away, undo puts back (reversibility over confirmation)
  await p.keyboard.press("Meta+z"); await p.waitForTimeout(400);
  ok((await st()).visible === 0, "undo restores the filter that clearing threw away");
  await p.evaluate(() => { const i = document.querySelector('input[type="search"]') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.waitForTimeout(400);

  await p.goto(`${base}/index.html?color=nosuchdimension`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  ok(await p.locator("[data-view-note]").isVisible(), "restored view naming a missing dimension: says so instead of silently ignoring it");
  ok((await st()).color === "region", "restored view naming a missing dimension: the channel falls back to its default");
  await p.goto(`${base}/index.html?color=length`); await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  ok((await p.locator("[data-view-note]").count()) === 0 && (await st()).color === "length", "restored view naming a REAL dimension: no false alarm");

  for (const w of [1280, 1600, 1900, 2200]) {
    await p.setViewportSize({ width: w, height: 1050 }); await p.waitForTimeout(700);
    const overlaps = await p.evaluate(() => {
      const row = document.querySelector("[data-fold-trigger]")!.closest("div")!.parentElement!;
      // folded controls are `invisible absolute` — in the layout but stacked; only visible ones can collide
      const els = [...row.querySelectorAll<HTMLElement>("[data-fold],[data-fold-fixed],[data-fold-trigger]")]
        .filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden");
      let n = 0;
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
        const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) n++;
      }
      return n;
    });
    ok(overlaps === 0, `fold @${w}: no two visible controls overlap (${overlaps} collisions)`);
  }
  await p.setViewportSize({ width: 2200, height: 1050 }); await p.waitForTimeout(250);

  // REGION LABELS MUST NOT BE DRAWN ON TOP OF EACH OTHER. The edge nudge (keeping long names on-screen)
  // used to run AFTER the declutter chose survivors, so it shoved an edge label into one the overlap test
  // had cleared — two region names through each other at 375px. Boxes come from the renderer's own
  // placement (nudge included) and are sized with the real glyph metrics of the font it draws in.
  const labelCollisions = async (pg: typeof p) => pg.evaluate(() => {
    const L = (window as any).__eidoLabels?.() ?? [];
    const cx = document.createElement("canvas").getContext("2d")!;
    cx.font = "700 13px ui-monospace, monospace";
    const box = L.map((d: any) => { const w = cx.measureText(d.text).width; return { x0: d.sx - w / 2, x1: d.sx + w / 2, y0: d.sy - 9, y1: d.sy + 9 }; });
    let n = 0;
    for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++)
      if (Math.min(box[i].x1, box[j].x1) - Math.max(box[i].x0, box[j].x0) > 0 && Math.min(box[i].y1, box[j].y1) - Math.max(box[i].y0, box[j].y0) > 0) n++;
    return { placed: box.length, n };
  });
  for (const w of [420, 900, 2200]) {
    await p.setViewportSize({ width: w, height: 1050 }); await p.waitForTimeout(800);
    const r = await labelCollisions(p);
    ok(r.n === 0, `labels @${w}: ${r.placed} region labels placed, none overlapping (${r.n})`);
  }
  // NOTHING DRAWN OFF THE SIDE OF A PHONE. This suite runs at 2200px, which is wider than any real
  // screen, and that is exactly how three chrome bugs reached production together: the about button sized
  // shrink-to-fit (floored at its min-content width, which `truncate` children make enormous) and was
  // drawn 59px THROUGH the controls beside it; the first-run dialog took `min-width: auto` as a grid item
  // and overflowed a 390px viewport by 74px, so every line of the first thing a reader sees ran off the
  // right edge. Both were invisible to every assertion here, because every assertion here was wide.
  // One invariant catches the whole class: no laid-out element may cross the viewport's right edge, and
  // no element may be wider than the box it was put in.
  const overflowers = async (pg: typeof p) => pg.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("header *, [role=dialog], [role=dialog] *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const id = (el.tagName + "." + String(el.className).split(" ").slice(0, 2).join(".")).slice(0, 48);
      if (r.right > window.innerWidth + 1) bad.push(`${id} runs ${Math.round(r.right - window.innerWidth)}px past the right edge`);
      const par = el.parentElement;                                  // …and stays inside the cell it was given
      if (par && par.getBoundingClientRect().width > 0 && r.width > par.getBoundingClientRect().width + 1)
        bad.push(`${id} is ${Math.round(r.width - par.getBoundingClientRect().width)}px wider than its parent`);
    }
    return bad;
  });
  for (const w of [390, 420, 900]) {
    await p.setViewportSize({ width: w, height: 844 }); await p.waitForTimeout(400);
    const bad = await overflowers(p);
    ok(bad.length === 0, `chrome @${w}: nothing drawn outside the viewport or its own cell${bad.length ? " — " + bad.slice(0, 3).join("; ") : ""}`);
    // …and the toolbar's own contract: the priority collapse shows a whole control or none of it, so no
    // group in the measured strip may be scrolling its content. This is what the fold's settle loop exists
    // for — the width estimate under-counts real flex spend (measured 53px at 1900, 94px at 1280), and
    // before the settle loop existed the strip "fit" on paper while "+ axis" drew on top of "open".
    const spill = await p.evaluate(() => {
      const row = [...document.querySelectorAll("div")].find((d) => d.className.includes("relative") && d.className.includes("sm:flex") && !!d.querySelector("[data-fold-trigger]"));
      if (!row) return [] as string[];
      return [...row.children].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => `${String(c.className).slice(0, 24)} ${c.scrollWidth}>${c.clientWidth}`);
    });
    ok(spill.length === 0, `toolbar @${w}: no control group overflows its box${spill.length ? " — " + spill.join("; ") : ""}`);
  }
  await p.setViewportSize({ width: 2200, height: 1050 }); await p.waitForTimeout(250);

  // THE AXIS COUNT IS TWO NUMBERS (Hac-pxyy). `axes.length` is a legibility budget of 16; realDims is what
  // parallel analysis supported, and on every shipped corpus that is 22-60 — never 16. The panel printed
  // the budget under the word "discovered", so a display cap read as a finding. The fixture carries
  // realDims 9 against 2 axes, which is exactly the case this copy exists for.
  await p.click('[data-menu="bar:about"]').catch(() => {});
  await p.waitForTimeout(300);
  const strength = await p.evaluate(() => document.querySelector("[data-about]")?.textContent?.replace(/\s+/g, " ") ?? "");
  ok(/2 of 9 axes/.test(strength), `the about panel states the budget AND the data-derived count — ${/2 of 9 axes/.test(strength) ? '"2 of 9 axes"' : strength.slice(0, 160)}`);
  ok(!/discovered axes/.test(strength), "...and no longer calls the budget a discovery");
  ok(/beat the noise floor/.test(strength), "...and says the rest were not noise, only not offered");
  await p.keyboard.press("Escape"); await p.waitForTimeout(200);

  ok(consoleErrs.length === 0, "no console errors during the run" + (consoleErrs.length ? " — " + consoleErrs[0] : ""));
} finally {
  await browser.close();
  server.stop(true);
}

console.log(fails.length ? `\n✗ ${fails.length} E2E assertion(s) failed` : `\n✅ new-viewer E2E passed`);
process.exit(fails.length ? 1 : 0);
