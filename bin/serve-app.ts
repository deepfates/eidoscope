// Serve the built app for live in-pane driving: real network stays real (HF datasets-server,
// OpenRouter, CDN embedder) — this only hands out index.html, exactly like the deployed site does.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");
const dist = join(ROOT, "viewer", "dist", "index.html");
if (!existsSync(dist)) { console.error("run `cd viewer && bun run build` first"); process.exit(2); }
const html = readFileSync(dist);
Bun.serve({ port: 5178, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
console.log("eidoscope app at http://localhost:5178 (built dist, real network)");
