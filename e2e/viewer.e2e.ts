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
function synth(): MapContract {
  const B = 3, PER = 30, N = B * PER;
  const axes = [
    { key: "a", name: "AxisA", low: "LowA", high: "HighA", variance: 0.4 },
    { key: "b", name: "AxisB", low: "LowB", high: "HighB", variance: 0.2 },
  ];
  const centers = [[0, 0], [1.6, 1.1], [-1.6, -1.1]];
  const ids: string[] = [], titles: string[] = [], cores: string[] = [], xy: number[][] = [], xyz: number[][] = [];
  const L0: number[] = [], L1: number[] = [], L2: number[] = [], L3: number[] = [], hub: number[] = [], nbr: number[][] = [];
  const sa: number[] = [], sb: number[] = [], read: (boolean | undefined)[] = [];
  for (let b = 0; b < B; b++) for (let i0 = 0; i0 < PER; i0++) {
    const k = b * PER + i0;
    const jx = (((i0 * 37) % 11) / 11 - 0.5) * 0.5, jy = (((i0 * 53) % 11) / 11 - 0.5) * 0.5;
    ids.push("d" + k); titles.push(`Doc ${b}.${i0}`); cores.push(`blob${b} item ${i0} ${["alpha", "beta", "gamma"][b]}`);
    xy.push(k === 0 ? [0, 0] : [centers[b][0] + jx, centers[b][1] + jy]);
    xyz.push([centers[b][0], centers[b][1], 0]);
    L0.push(b); L1.push(b * 2 + (i0 < 15 ? 0 : 1));
    L2.push(b * 4 + Math.min(3, Math.floor(i0 / 7.5)));
    L3.push(b * 8 + Math.min(7, Math.floor(i0 / 3.75)));
    hub.push(1 + (i0 % 5)); nbr.push([b * PER + ((i0 + 1) % PER), b * PER + ((i0 + 2) % PER)]);
    sa.push(Math.round((i0 / PER) * 100)); sb.push(Math.round(((PER - i0) / PER) * 100));
    read.push(k % 3 === 0 ? true : false);
  }
  const levels = [L0, L1, L2, L3], counts = [3, 6, 12, 24];
  const levelLabels = counts.map((n, i) => Array.from({ length: n }, (_, c) => `L${i}R${c}`));
  const cluster = L2, k = 12; // default level (di=2)
  const clusters = Array.from({ length: k }, (_, c) => ({ c, n: cluster.filter((x) => x === c).length, label: "L2R" + c, cx: 0, cy: 0 }));
  const cite: number[][] = ids.map(() => []); cite[0] = [1, 2, 31]; cite[3] = [4]; cite[31] = [0];
  const ghosts = [{ title: "GhostPaper Attention", arxiv: "2101.00001", url: "https://arxiv.org/abs/2101.00001", n: 5, core: "a cited-but-absent paper", xy: [0.8, 0.5] as [number, number], sim: 0.6 }];
  return {
    version: 1, ids, titles, cores, notes: ids.map(() => ({ a: "note on a", b: "note on b" })), axes,
    scores: { a: sa, b: sb }, xy, xyz, cluster, k, di: 2, hub, nbr, clusters, levels, counts, levelLabels,
    levelBlurbs: counts.map((n) => Array.from({ length: n }, () => "blurb")),
    cite, citec: hub.map((h) => h * 2), ghosts, read,
    urls: ids.map((_, i) => `https://read.example/${i}`),
    sources: ids.map((_, i) => (i % 2 ? `https://src.example/${i}` : undefined)),
    siteNames: ids.map((_, i) => (i % 2 ? "src.example" : undefined)),
    authors: ids.map((_, i) => `Author ${i % 4}`),
    dates: ids.map((_, i) => 1_700_000_000_000 + i * 86_400_000),
  };
}

// a deliberately DIFFERENT map (2 regions vs 12) so ?map= loading it is distinguishable from the default
function altSynth(): MapContract {
  const N = 6, ids: string[] = [], titles: string[] = [], cores: string[] = [], xy: number[][] = [], xyz: number[][] = [], cluster: number[] = [], hub: number[] = [], nbr: number[][] = [], sa: number[] = [];
  for (let i = 0; i < N; i++) { const b = i < 3 ? 0 : 1; ids.push("a" + i); titles.push("Alt " + i); cores.push("alt doc " + i); xy.push([b ? 1 : -1, (i % 3) * 0.2]); xyz.push([b ? 1 : -1, 0, 0]); cluster.push(b); hub.push(1); nbr.push([(i + 1) % N]); sa.push(Math.round((i / N) * 100)); }
  return {
    version: 1, ids, titles, cores, notes: ids.map(() => ({ a: "n" })), axes: [{ key: "a", name: "AxisA", low: "Lo", high: "Hi", variance: 0.5 }],
    scores: { a: sa }, xy, xyz, cluster, k: 2, di: 0, hub, nbr,
    clusters: [{ c: 0, n: 3, label: "Alt-A" }, { c: 1, n: 3, label: "Alt-B" }],
    levels: [cluster], counts: [2], levelLabels: [["Alt-A", "Alt-B"]], levelBlurbs: [["x", "x"]],
  };
}

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
const setGrain = (v: number) => p.evaluate((v) => { const s = document.querySelector('input[type=range]') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(s, String(v)); s.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const btn = (re: RegExp) => p.locator("button", { hasText: re }).first();
const setControl = (label: string, value: string) => p.evaluate(([label, value]) => { const l = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.trim() === label); const s = l?.querySelector("select") as HTMLSelectElement | undefined; if (!s) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!; set.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); }, [label, value] as [string, string]);
// deck's onClick fires the SAME way for a desktop mouse click and a touch tap; Playwright can't cleanly
// drive deck's mouse-gesture recognizer (a harness limit), but touchscreen.tap reaches it reliably — so a
// tap is the honest proxy for "click/tap a card". Single-click card-open is debounced 220ms behind a
// possible double-click (drill), so reads wait it out.

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
  await btn(/^reset$/).click(); await p.waitForTimeout(200); await setGrain(3); await p.waitForTimeout(200);
  const fit = await st(); const lFit = fit.labels;
  const [cx, cy] = await proj([0, 0]);
  await p.mouse.move(cx, cy); // wheel targets whatever's under the cursor — put it over the canvas
  for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, -140); await p.waitForTimeout(20); }
  await p.waitForTimeout(300);
  const zm = await st();
  ok(zm.zoom > fit.zoom, `wheel actually zoomed the deck — ${fit.zoom.toFixed(2)}→${zm.zoom.toFixed(2)}`);
  ok(zm.labels > lFit, `zooming in reveals more region labels — fit=${lFit} → zoom=${zm.labels}`);

  // 4. THE REGRESSION: legend-click isolates + zooms but must NOT change grain; re-click releases
  await btn(/^reset$/).click(); await p.waitForTimeout(200); s = await st(); const g0 = s.grain, z0 = s.zoom;
  const legendItem = p.locator('[role="button"][aria-label^="isolate region"]').first();
  await legendItem.click(); await p.waitForTimeout(200); s = await st();
  ok(s.grain === g0, `legend-click leaves grain unchanged — grain ${g0}→${s.grain}`);
  ok(s.pin !== null, "legend-click pins/isolates the region");
  ok(s.zoom > z0 * 1.15, `legend-click zooms IN — ${z0.toFixed(2)}→${s.zoom.toFixed(2)}`);
  await legendItem.click(); await p.waitForTimeout(200); s = await st();
  ok(s.pin === null, `re-click releases the pin — pin=${s.pin}`);

  // 5. drill via map double-click steps grain finer (and does NOT open a card)
  await btn(/^reset$/).click(); await p.waitForTimeout(200); const gd = (await st()).grain;
  await p.mouse.dblclick(cx, cy); await p.waitForTimeout(400); s = await st();
  ok(s.grain > gd, `double-click drills one step finer — grain ${gd}→${s.grain}`);
  // NOTE: the "drill must not ALSO open a card" debounce is real (real-device dblclick fires deck.onClick
  // twice), but Playwright's synthetic mouse doesn't drive deck's onClick deterministically, so asserting
  // it here would pass vacuously — deliberately NOT asserted rather than give false confidence.

  // 6. tap/click a card → detail panel (exact node-0 pixel via project; desktop click shares this onClick path)
  await btn(/^reset$/).click(); await p.waitForTimeout(200);
  const [nx, ny] = await proj([0, 0]);
  await p.touchscreen.tap(nx, ny); await p.waitForTimeout(350); s = await st();
  ok(s.detail === true && s.focus === 0, `tapping a card opens its detail panel — detail=${s.detail} focus=${s.focus}`);

  // 8. FRONTIER: cite + ghost toggles flip; hovering a ghost reports 'ghost' (not a wrong card); click → arXiv
  await btn(/^reset$/).click(); await p.waitForTimeout(200);
  await btn(/cite edges/i).click(); await btn(/frontier/i).click(); await p.waitForTimeout(150); s = await st();
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
  await btn(/^reset$/).click(); await p.waitForTimeout(150);
  const t0 = (await st()).theme;
  await p.locator('button[aria-label*="theme"]').click(); await p.waitForTimeout(150);
  const t1 = (await st()).theme, attr = await p.evaluate(() => document.documentElement.dataset.theme), stored = await p.evaluate(() => localStorage.getItem("eido-theme"));
  ok(t1 !== t0 && attr === t1 && stored === t1, `theme toggle flips + persists — ${t0}→${t1} attr=${attr} stored=${stored}`);

  // 10. DECK shows the whole corpus (was capped at 300) + unread-only filters
  await btn(/^reset$/).click(); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(200);
  const all = await p.locator(".grid button").count();
  ok(all === 90, `deck lists the whole corpus (90 cards, not capped) — got ${all}`);
  await btn(/unread only/i).click(); await p.waitForTimeout(200);
  const unread = await p.locator(".grid button").count();
  ok(unread < all && unread === 60, `unread-only drops read cards — ${all}→${unread}`);
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);

  // 11. reset clears everything back to defaults
  await btn(/^reset$/).click(); await p.waitForTimeout(250); s = await st();
  ok(s.grain === 2 && s.pin === null && s.focus === null && s.detail === false, `reset restores default grain + clears pin/focus/detail — ${JSON.stringify({ grain: s.grain, pin: s.pin, focus: s.focus, detail: s.detail })}`);

  // 11b. HISTORY: browser Back closes an open overlay (the mobile-escape fix, eid-fktf)
  await btn(/^reset$/).click(); await p.waitForTimeout(150);
  await btn(/^deck$/).click(); await p.waitForTimeout(200);
  ok((await st()).deckOpen === true, "deck opens (pushes history)");
  await p.goBack(); await p.waitForTimeout(300);
  ok((await st()).deckOpen === false, "browser Back closes the deck — mobile back gesture escapes the modal (eid-fktf)");

  // 11c. DEEP-LINK: view state mirrors to the URL, and a link restores it (incl. a specific card) — eid-yxqu
  await btn(/^reset$/).click(); await p.waitForTimeout(150);
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

  // 12. ?map= loads a DIFFERENT corpus from the SAME built viewer (the dual-deploy path)
  await p.goto(base + "/index.html?map=alt.eido");
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(250);
  const alt = await st();
  ok(alt.k === 2 && alt.regions === 2, `?map=alt.eido loads the alternate 2-region map (not the default 12) — k=${alt.k} regions=${alt.regions}`);

  ok(consoleErrs.length === 0, "no console errors during the run" + (consoleErrs.length ? " — " + consoleErrs[0] : ""));
} finally {
  await browser.close();
  server.stop(true);
}

console.log(fails.length ? `\n✗ ${fails.length} E2E assertion(s) failed` : `\n✅ new-viewer E2E passed`);
process.exit(fails.length ? 1 : 0);
