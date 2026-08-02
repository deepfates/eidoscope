import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two outputs from one codebase:
//  - default `vite build` + singlefile → ONE portable eidoscope.html (the self-contained artifact)
//  - the same app can be served/hosted and fetch its data (see the loader, eid-enqr)
export default defineConfig({
  plugins: [svelte(), tailwindcss(), viteSingleFile()],
  build: { target: "es2022", assetsInlineLimit: 100_000_000 },
});
