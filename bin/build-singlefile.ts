// Build a FULLY self-contained single .html: the built viewer with a .eido inlined as base64 on
// window.__EIDO_DATA__. No server, no separate data file — email it, drop it on disk, open it offline.
// The inline logic itself lives in src/singlefile.ts (shared with the pipeline, which emits one per run).
// Usage: bun bin/build-singlefile.ts [path/to/map.eido] [out.html]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { singlefileHTML, viewerBuilt } from "../src/singlefile.ts";

const dist = join(import.meta.dir, "..", "viewer", "dist");
const eidoPath = process.argv[2] || join(dist, "map.eido");
const outPath = process.argv[3] || join(dist, "eidoscope-standalone.html");

if (!viewerBuilt()) { console.error("viewer not built — run `cd viewer && bun run build` first"); process.exit(1); }
const html = singlefileHTML(readFileSync(eidoPath))!;
writeFileSync(outPath, html);
console.log(`wrote ${outPath}  (${(html.length / 1e6).toFixed(1)} MB, self-contained — open from disk, no server)`);
