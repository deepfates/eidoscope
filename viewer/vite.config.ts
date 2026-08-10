import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two outputs from one codebase:
//  - default `vite build` + singlefile → ONE portable eidoscope.html (the self-contained artifact)
//  - the same app can be served/hosted and fetch its data (see the loader, eid-enqr)
export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    // transformers.js's web bundle carries a `new URL("ort-wasm….wasm", import.meta.url)` FALLBACK that
    // vite emits as a 21.6MB asset (58MB html once base64-inlined). It is dead weight at runtime: the
    // library sets env.backends.onnx.wasm.wasmPaths to its CDN default before ort init (onnx.js), so the
    // wasm binary is always fetched via wasmPaths (CDN in prod, localhost via the e2e seam) — never from
    // this asset. Drop it from the bundle instead of shipping 21.6MB of unreachable bytes.
    viteSingleFile(),
    {
      name: "drop-dead-ort-wasm-asset",
      // viteSingleFile's recommended config (enforce: "post") forces assetsInlineLimit to inline
      // EVERYTHING; this plugin is also "post" and listed after, so its hook wins and exempts .wasm
      // from base64-inlining…
      enforce: "post",
      config: () => ({ build: { assetsInlineLimit: (file: string) => !file.endsWith(".wasm") } }),
      // …which keeps it an emitted asset file, deleted here before write.
      generateBundle(_opts, bundle) { for (const k of Object.keys(bundle)) if (k.endsWith(".wasm")) delete bundle[k]; },
    },
  ],
  build: { target: "es2022", assetsInlineLimit: 100_000_000 },
  // The engine worker (viewer/src/engine.worker.ts) is imported `?worker&inline` — vite's documented
  // pattern for a worker inside a single-file artifact (the worker becomes a base64 blob, created via
  // Blob URL at runtime). Module format (transformers.js is ESM) + inlineDynamicImports so the worker
  // is ONE chunk: a blob-URL module worker cannot resolve split chunks or dynamic-import specifiers
  // relative to itself, so everything it needs (engine, ax, transformers.js) is bundled in.
  worker: { format: "es", rollupOptions: { output: { inlineDynamicImports: true } } },
  // transformers.js ships a prebuilt web bundle; esbuild prebundling chokes on its wasm-adjacent imports,
  // so keep it out of dep optimization (the documented bundler guidance). It stays a lazy dynamic import
  // in the app, so the runtime is a code-split chunk in hosted mode and never blocks first paint.
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
});
