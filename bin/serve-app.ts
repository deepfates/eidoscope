// Serve the built app for live in-pane driving: real network stays real (HF datasets-server,
// OpenRouter, CDN embedder) — this hands out index.html, plus anything in viewer/public so a real
// corpus can be opened (?map=readwise.eido). Without the public files every local check of a
// map-dependent change had to go via the deployed site, which meant deploying to look at it.
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
const ROOT = join(import.meta.dir, "..");
const dist = join(ROOT, "viewer", "dist", "index.html");
const PUBLIC = join(ROOT, "viewer", "public");
if (!existsSync(dist)) { console.error("run `cd viewer && bun run build` first"); process.exit(2); }
const html = readFileSync(dist);
const TYPES: Record<string, string> = { ".eido": "application/octet-stream", ".json": "application/json", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png" };

Bun.serve({
  port: 5178,
  fetch(req) {
    const path = new URL(req.url).pathname;
    // contain the path inside viewer/public — a dev server is still not a place to serve arbitrary files
    const rel = normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
    const file = join(PUBLIC, rel);
    if (rel && file.startsWith(PUBLIC + "/") && existsSync(file)) {
      const ext = rel.slice(rel.lastIndexOf("."));
      return new Response(Bun.file(file), { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});
console.log("eidoscope app at http://localhost:5178 (built dist + viewer/public, real network)");
