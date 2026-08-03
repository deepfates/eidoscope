// Offline single-file test (eid-4ftw): a passed-around .html with the map inlined must load from file://
// with NO server, and its ?card= deep-link must resolve. Builds a standalone, opens it via file://, asserts.
// Run: cd viewer && bun run build   then   bun run e2e/offline.ts
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeMap } from "../src/mapbin.ts";

const dist = join(import.meta.dir, "..", "viewer", "dist");
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "map.eido"))) { console.error("run `cd viewer && bun run build` first"); process.exit(2); }

// build the self-contained file (inline map.eido as base64 on window.__EIDO_DATA__)
const html = readFileSync(join(dist, "index.html"), "utf8");
const eido = readFileSync(join(dist, "map.eido"));
const b64 = eido.toString("base64");
const standalone = html.replace("</head>", `<script>window.__EIDO_DATA__=${JSON.stringify(b64)}</script></head>`);
const out = join(tmpdir(), "eidoscope-standalone-test.html");
writeFileSync(out, standalone);
const targetId = decodeMap(eido).ids[10];   // a real card id to deep-link to

const fails: string[] = [];
const ok = (c: boolean, m: string) => { console.log(c ? "  ✓" : "  ✗", m); if (!c) fails.push(m); };

const browser = await chromium.launch();
const p = await browser.newPage();
const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e)));
try {
  console.log(`offline single-file test — file://…?card=${targetId}\n`);
  // open straight from disk with a deep-link, NO web server
  await p.goto(`file://${out}?card=${encodeURIComponent(targetId)}`);
  await p.waitForFunction(() => !!(window as any).__eido, null, { timeout: 15000 });
  await p.waitForTimeout(600);
  const s = await p.evaluate(() => (window as any).__eido());
  ok(errs.length === 0, "loads from file:// with no server, no page errors" + (errs.length ? " — " + errs[0] : ""));
  ok(!!s && s.regions > 0, `map renders offline (embedded data) — ${s?.regions} regions`);
  ok(s?.detail === true, `?card= deep-link opens the card from file:// — detail=${s?.detail}`);
  const title = await p.evaluate(() => document.title);
  ok(/eidoscope/i.test(title) && title.length > "eidoscope 🔭".length, `tab shows the corpus identity offline — "${title}"`);
} catch (e: any) { ok(false, "threw: " + (e.message || e)); }
finally { await browser.close(); }

console.log(fails.length ? `\n✗ ${fails.length} offline assertion(s) failed` : `\n✅ offline single-file works (loads + deep-links from file://)`);
process.exit(fails.length ? 1 : 0);
