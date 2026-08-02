// Headless interaction E2E for the viewer — the net for DOM-level bugs that the bun contract tests
// can't see (e.g. the legend-click that blew out the grain). Renders a SYNTHETIC map (hermetic — no
// fixture, no 15k run), drives the real DOM in Chromium, and asserts interaction invariants via the
// read-only window.__eido() seam. Run: bun run e2e/viewer.e2e.ts   (exits non-zero on any failure)
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHTML, type MapData } from "../src/render.ts";

// A synthetic corpus: 3 blobs (blob 0 centered at the ORIGIN so a center double-click lands on it),
// with a NESTED 4-level grain ladder [3,6,12,24] refining by index. Deterministic — no RNG.
function synth(): MapData {
  const B = 3, PER = 30, N = B * PER;
  const axes = [{ key: "a", name: "AxisA", low: "LowA", high: "HighA" }, { key: "b", name: "AxisB", low: "LowB", high: "HighB" }];
  // blobs spread far apart with a WIDE internal spread, so a region occupies a real fraction of the
  // map and fitTo computes a genuine, non-saturated zoom (a tiny synthetic region would just hit the clamp).
  const centers = [[0, 0], [1.6, 1.1], [-1.6, -1.1]];
  const ids: string[] = [], titles: string[] = [], cores: string[] = [], xy: number[][] = [], xyz: number[][] = [];
  const L0: number[] = [], L1: number[] = [], L2: number[] = [], L3: number[] = [], hub: number[] = [], nbr: number[][] = [];
  const sa: number[] = [], sb: number[] = [];
  for (let b = 0; b < B; b++) for (let i0 = 0; i0 < PER; i0++) {
    const k = b * PER + i0;
    const jx = (((i0 * 37) % 11) / 11 - 0.5) * 0.5, jy = (((i0 * 53) % 11) / 11 - 0.5) * 0.5;
    ids.push("d" + k); titles.push(`Doc ${b}.${i0}`); cores.push(`blob${b} item ${i0} ${["alpha", "beta", "gamma"][b]}`);
    // node 0 sits EXACTLY at the origin so a center dbl-click is guaranteed a hit
    xy.push(k === 0 ? [0, 0] : [centers[b][0] + jx, centers[b][1] + jy]);
    xyz.push([centers[b][0], centers[b][1], 0]);
    L0.push(b); L1.push(b * 2 + (i0 < 15 ? 0 : 1));
    L2.push(b * 4 + Math.min(3, Math.floor(i0 / 7.5)));
    L3.push(b * 8 + Math.min(7, Math.floor(i0 / 3.75)));
    hub.push(1 + (i0 % 5)); nbr.push([b * PER + ((i0 + 1) % PER)]);
    sa.push(Math.round((i0 / PER) * 100)); sb.push(Math.round(((PER - i0) / PER) * 100));
  }
  const levels = [L0, L1, L2, L3], counts = [3, 6, 12, 24];
  const lab = (n: number, tag: string) => Array.from({ length: n }, (_, c) => `${tag}${c}`);
  const levelLabels = counts.map((n, i) => lab(n, "L" + i + "R"));
  const cluster = L2, k = 12; // default level (nearest ~18)
  const clusters = Array.from({ length: k }, (c) => c).map((_, c) => ({ c, n: cluster.filter((x) => x === c).length, label: "L2R" + c, cx: 0, cy: 0 }));
  return {
    ids, titles, cores, notes: ids.map(() => ({ a: "na", b: "nb" })), axes,
    scores: { a: sa, b: sb }, xy, xyz, cluster, k, di: 2, hub, nbr, clusters, levels, counts, levelLabels,
    levelBlurbs: counts.map((n) => Array.from({ length: n }, () => "blurb")),
  };
}

const html = renderHTML(synth());
mkdirSync(join(tmpdir(), "eido-e2e"), { recursive: true });
const file = join(tmpdir(), "eido-e2e", "viewer.html");
writeFileSync(file, html);

const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { if (cond) console.log("  ✓", msg); else { console.log("  ✗", msg); fails.push(msg); } };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 2, hasTouch: true });
const pageErrs: string[] = []; p.on("pageerror", (e) => pageErrs.push(String(e)));
const consoleErrs: string[] = []; p.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
await p.goto("file://" + file);
await p.waitForTimeout(600);
await p.evaluate(() => (document.getElementById("introgo") as any)?.click()); // dismiss intro
await p.waitForTimeout(150);

const st = () => p.evaluate(() => (window as any).__eido());
const setRange = (id: string, v: number) => p.evaluate(({ id, v }: any) => { const s: any = document.getElementById(id); s.value = String(v); s.dispatchEvent(new Event("input")); }, { id, v });

console.log("eidoscope viewer E2E\n");
try {
  // 1. clean load + default grain
  ok(pageErrs.length === 0, "no page errors on load" + (pageErrs.length ? " — " + pageErrs[0] : ""));
  let s = await st();
  ok(s.grain === 2 && s.k === 12, `opens at default grain (12 regions) — got grain=${s.grain} k=${s.k}`);

  // 2. grain slider moves across the ladder
  await setRange("grain", 0); s = await st();
  ok(s.grain === 0 && s.k === 3, `grain slider → coarsest (3 regions) — got grain=${s.grain} k=${s.k}`);
  await setRange("grain", 3); s = await st();
  ok(s.grain === 3 && s.k === 24, `grain slider → finest (24 regions) — got grain=${s.grain} k=${s.k}`);

  // 3. THE REGRESSION: legend-click isolates + zooms but must NOT change the grain
  await p.click("#reset"); await p.waitForTimeout(150); s = await st(); const g0 = s.grain, z0 = s.zoom;
  await p.click("#legend [data-cl]"); await p.waitForTimeout(150); s = await st();
  ok(s.grain === g0, `legend-click leaves grain unchanged (THE bug) — grain ${g0}→${s.grain}`);
  ok(s.pin !== null, "legend-click pins/isolates the region");
  // zoom BEHAVIOR (separate from the grain regression): fitTo computed a real zoom-in, not the max clamp
  ok(s.zoom > z0 * 1.3 && s.zoom < 21.9, `legend-click zooms IN to a sensible, non-clamped level — ${z0}→${s.zoom}`);
  await p.click("#legend [data-cl]"); await p.waitForTimeout(150); s = await st();
  ok(s.pin === null && Math.abs(s.zoom - z0) < 0.05, `clicking the pinned region again releases + returns to baseline zoom — pin=${s.pin} zoom=${s.zoom} (base ${z0})`);

  // 4. drill via map double-click DOES step the grain finer (and doesn't leave a stray card open)
  await p.click("#reset"); await p.waitForTimeout(150); const gd = (await st()).grain;
  await p.dblclick("#c", { position: { x: 800, y: 525 } }); await p.waitForTimeout(250); s = await st();
  ok(s.grain > gd, `double-click drills one step finer — grain ${gd}→${s.grain}`);
  ok(s.detail === false, "drill does NOT also open a card panel (debounce works)");

  // 5. clicking a card opens the detail panel
  await p.click("#reset"); await p.waitForTimeout(150);
  await p.evaluate(() => (window as any).focusIdx(5)); await p.waitForTimeout(150); s = await st();
  ok(s.detail === true && s.focus === 5, `opening a card shows its detail panel — detail=${s.detail} focus=${s.focus}`);

  // 6. TOUCH (the mobile ratchet): a tap on a node opens its card
  await p.click("#reset"); await p.waitForTimeout(150);
  await p.touchscreen.tap(800, 525); await p.waitForTimeout(200); s = await st();  // node 0 sits at screen center
  ok(s.detail === true && s.focus === 0, `tap opens a card on touch — detail=${s.detail} focus=${s.focus}`);

  // 7. reset returns to the default grain and clears everything
  await p.click("#reset"); await p.waitForTimeout(200); s = await st();
  ok(s.grain === 2 && s.pin === null && s.focus === null && s.zoom < 1.05 && s.detail === false, `reset restores default grain + clears pin/focus/zoom — ${JSON.stringify(s)}`);

  ok(consoleErrs.length === 0, "no console errors during the whole run" + (consoleErrs.length ? " — " + consoleErrs[0] : ""));
} finally {
  await b.close();
}

console.log(fails.length ? `\n✗ ${fails.length} E2E assertion(s) failed` : `\n✅ viewer E2E passed`);
process.exit(fails.length ? 1 : 0);
