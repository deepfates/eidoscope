import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { injectEido } from "./export.ts";

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
  // the injection itself is the shared, host-free emit (src/export.ts) — the app's Export → single file
  // uses the identical function on its own fetched shell.
  return injectEido(readFileSync(indexPath, "utf8"), eido);
}
