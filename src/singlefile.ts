import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The ONE place the "inline the built viewer + a .eido into a single offline HTML" logic lives — used by the
// pipeline (emit a self-contained explorer every run) and bin/build-singlefile.ts. The viewer build
// (viewer/dist/index.html, already JS/CSS-inlined by vite-plugin-singlefile) is the shell; we inject the
// .eido as base64 on window.__EIDO_DATA__, which the loader (viewer/src/loader.ts) prefers over any ?map=.
// Returns null when the viewer isn't built yet, so a run still emits the .eido — it just skips the HTML.
const DIST = join(import.meta.dir, "..", "viewer", "dist");

export function viewerBuilt(): boolean {
  return existsSync(join(DIST, "index.html"));
}

export function singlefileHTML(eido: Uint8Array): string | null {
  const indexPath = join(DIST, "index.html");
  if (!existsSync(indexPath)) return null;
  const shell = readFileSync(indexPath, "utf8");
  // a plain <script> in <head> runs during parse, before the app's deferred module script reads the payload
  const inject = `<script>window.__EIDO_DATA__=${JSON.stringify(Buffer.from(eido).toString("base64"))}</script>`;
  return shell.includes("</head>") ? shell.replace("</head>", inject + "</head>") : inject + shell;
}
