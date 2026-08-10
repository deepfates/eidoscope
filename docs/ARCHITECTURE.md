# The app and the file

Ruled by deepfates 2026-08-09, after the falsification rounds. This is the architecture the work
builds against. CLAUDE.md holds the discipline; this holds the shape.

## The bilateral

**eidoscope is an application; the .eido is a document.** Two artifacts, cleanly split, like
Blender and a .blend — delivered local-first (a tab, a PWA, an Electron shell: the same app in
different costumes), in the Excalidraw lineage: no account, no server, files you own.

- **The app** is stateless and universal. It owns every control and every view. It ingests (folder
  picker, drag-a-folder, HuggingFace datasets, future connectors as plugins), computes in-page
  (MiniLM via transformers.js, PCA, the patched UMAP), and names via an LLM key the user holds —
  the page calls the provider directly (OpenRouter answers `access-control-allow-origin: *`;
  measured 2026-08-09). Opening the app clean anywhere is always safe: it is nobody's data.
- **The file** is pure data — no HTML, no app. It is the cached, compressed form of the work:
  the portable edge-object you hand someone. Open it in any instance of the app and the whole
  workspace re-presents.

The CLI is not a second product: it is the **headless face of the same engine** — batch, scripting,
and long unattended runs — reading and writing the same files. In the app the engine runs inside a
Web Worker, so any corpus size runs without freezing the tab; the ingest panel states honest
time/spend estimates and proceeds — it never refuses by size. The choice of face is the user's.

## The three strata inside a .eido

1. **Source truth — the cards.** Title + core + placements + metadata: the nexus everything flows
   through. Truth came in from the corpus to make them; truth goes out of them to every export.
   Not recomputable. This stratum IS the document.
2. **Caches — recomputable, with one declared shift.** Card vectors, projections, layout, clusters:
   expensive, carried because the computation is the thing worth sharing, re-derivable from the
   cards. **Declared honestly:** the parent's axes and positions were discovered from *full-text*
   embeddings, which the file does not carry — recompute-from-file is therefore **card-basis**
   (exactly what DESCEND already does and says). Provenance records the corpus source so a full
   truth-basis recompute can re-fetch it when reachable. (Carrying full-text embeddings was
   measured at +37–57% file size and ruled out as the default.)
3. **Work — yours.** Named views, selections, derived axes. Saved in the file, restored anywhere.

## The loops

- **Ingest:** open app → point at a corpus (folder / HF dataset / connector) → embed, discover,
  card, layout in a Web Worker → a map, and a file when you save. The panel states measured
  time/spend estimates up front (the wall is embed+card time, not layout) and proceeds at any
  size; the CLI twin is a convenience for long unattended runs, not a requirement.
- **Work:** every operator in the grammar, in the app — including **descend as a gesture**
  (subset layout is interactive at any selection size; naming falls back to PC labels until a key
  is present). No file ferrying between intent and result, ever.
- **Save:** in place via File System Access where it exists (Chromium); a download preserving the
  filename elsewhere (Safari/Firefox have no write-in-place — checked 2026-08-09). One verb,
  honest per-browser behavior.
- **Share:** hand the .eido (they open it in the app — any instance, or the hosted one), or
  **Export → single file** to burn the current gem into a self-contained HTML for someone with no
  app at all. The baked HTML is an *export*, not the document. Other exports flow from the cards:
  vault (markdown), JSON, whatever a Sink speaks.

## What the hosted site is

Where the app lives, nothing more. The demo corpora are sample files it can open — not the site's
identity. Hosted/collab infrastructure, accounts, npm publish timing: far-side, unchanged.

## What this retires

The bucket brigade: selection-JSON downloads ferried to CLI commands by hand, saves severed into
~/Downloads, out/-dir smear, the viewer/pipeline split pretending to be a product decision. The
user is never again the IPC.
