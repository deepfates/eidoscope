// Build a FULLY self-contained single .html: the singlefile viewer build (JS+CSS already inlined by
// vite-plugin-singlefile) with the .eido map inlined as base64 on window.__EIDO_DATA__. No server, no
// separate data file — email it, drop it on disk, open it offline. The loader (viewer/src/loader.ts)
// prefers window.__EIDO_DATA__ when present, so ?map= is irrelevant and ?card=/view-state links still
// resolve from file://.
// Usage: bun bin/build-singlefile.ts [path/to/map.eido] [out.html]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "viewer", "dist");
const eidoPath = process.argv[2] || join(dist, "map.eido");
const outPath = process.argv[3] || join(dist, "eidoscope-standalone.html");

const html = readFileSync(join(dist, "index.html"), "utf8");
const b64 = readFileSync(eidoPath).toString("base64");
// run before the app's (deferred) module script — a plain <script> in <head> executes during parse
const inject = `<script>window.__EIDO_DATA__=${JSON.stringify(b64)}</script>`;
const out = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : inject + html;
writeFileSync(outPath, out);
console.log(`wrote ${outPath}  (${(out.length / 1e6).toFixed(1)} MB, self-contained — open from disk, no server)`);
