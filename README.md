# eidoscope 🔭

*An instrument for seeing the forms in a corpus.*

kaleidoscope minus the *kalos* — **eidos** (the form a thing takes) + **-scope** (an instrument
you look through). You run a corpus through the eidoscope and get back each document's **eidos**:
its form on the corpus's own axes. Then you look through the scope at all the forms at once — the
object turned in the light, every angle at the same time.

## The idea

Don't embed the documents. Embed a **uniform, interpretable re-description** of each one — a
**card** — positioned on axes that were *discovered from the data*, not imposed. The card is a
concept bottleneck: instead of a raw text vector you get a legible coordinate, so the map means
something and you can reorganize it by any axis.

The discipline is the whole thing, and it's the grug/gorm split made precise:

- **solid** (deterministic math) **discovers** the axes *and* **places** every document on them —
  PCA on the embeddings (plus a parallel-analysis check so it only keeps axes that beat noise), and
  a document's position on an axis is simply its PCA projection: calibrated, reproducible, exact.
- **fluid** (an LLM, via [Ax](https://github.com/ax-llm/ax) signatures) only ever **labels** each
  axis's poles, **re-states** each document in one uniform voice (so a tweet and a paper compare by
  content, not style — preserving the specifics, matched to the source's density), and writes a
  short **placement** per axis. It names and normalizes; it never scores or positions.

That constraint — *fluid intelligence may name, never place or invent the ontology* — is why the
map isn't a hallucinated cartoon of three data points. It's the moat. (An earlier version also had
the model score each doc 0–100 per axis; that was removed — the scores saturated and, on some docs,
hallucinated extremity the geometry didn't have, while the PCA projection was the exact position all
along.)

## Shape

```
documents ──▶ discover + label axes ──▶ card each doc ──▶ embed cards ──▶ project ──▶ deck
              (PCA + parallel-analysis    (Ax signature,   (MiniLM)      (umap-js)   (JSONL)
               + Ax labelAxes)             provider-agnostic)                          │
                                                                                       ▼
                                                                            readers: map · deck-view
```

The **deck** (one card per line, JSONL — inspectable, appendable) is the asset. The map viewer,
the card/spectrum view, the citation frontier, and the trajectory report are all *readers* of the
deck, not the app.

Built on **[`@huggingface/transformers`](https://github.com/huggingface/transformers.js)** (local
MiniLM embeddings — no key, nothing leaves the machine) and **[Ax](https://github.com/ax-llm/ax)**
(DSPy for TypeScript — the gorm signatures, with validation, retries, traces, and any
OpenAI-compatible provider incl. local servers like LM Studio, so cloud or local is one line of config).

## Use it

```sh
bun install
bun run src/cli.ts example           # try it: a bundled 24-doc demo corpus across domains
bun run src/cli.ts <folder>          # any folder of .md/.txt -> out/<name>/: deck.jsonl + <name>.eido + <name>.html + REPORT.md (+ STATE.md if dated)
bun run src/cli.ts <folder> --limit 200
bun run src/cli.ts <folder> --min-chars 100  # include short entries (default: skip bodies < 200 chars, and it says how many)
bun run src/cli.ts <folder> --frontier   # also pull the citation frontier (arxiv corpora)
bun run src/cli.ts <folder> --embed raw   # A/B: build the map from raw full-text instead of the cards (to see what the bottleneck buys)
bun run src/cli.ts <folder> --debug-json  # also dump map-data.json (see below) — off by default: it OOMs on big corpora
open out/<folder-name>/<folder-name>.html
```

Bigger is better: PCA and the axis-labeling need conceptual spread, so ~50+ documents give
sharper axes. Small corpora still run (the tool degrades gracefully) but the axis guard will
honestly flag when the axes overlap.

Embeddings are local (`@huggingface/transformers`, MiniLM) — no key, no service. The LLM is any
OpenAI-compatible endpoint (env-overridable): `EIDOSCOPE_API_URL` (default OpenRouter),
`EIDOSCOPE_MODEL`, `OPENROUTER_API_KEY`.

**Fully local** (no key, nothing leaves the machine) — point it at any local OpenAI-compatible
server. E.g. LM Studio:

```sh
lms load google/gemma-4-12b --context-length 32768   # a capable instruct model, ample context
EIDOSCOPE_API_URL=http://localhost:1234/v1 EIDOSCOPE_MODEL=google/gemma-4-12b OPENROUTER_API_KEY=local \
  bun run src/cli.ts <folder>
```

Two notes from testing: use a **capable** model (≈12B+ — tiny models drop card fields), and give it
**enough context** (labeling all axes in one call needs ~8k+; 32k is safe). And mind the speed — one
card is one LLM call, and on local hardware that's tens of seconds each, so a large corpus (1000+
docs) is an overnight run. Reach for a cloud endpoint, or a batching server (vLLM), when you want it
fast: LM Studio serializes on a single model, so raising `EIDOSCOPE_CONCURRENCY` barely helps there.

## The viewer

One viewer (**`viewer/`**, Svelte 5 + deck.gl + Vite): GPU-rendered, touch-first, reads the compact
binary `.eido`. Every pipeline run also inlines it into a self-contained `<name>.html` — one file,
just open it, works from `file://`.

The controls are one grammar: every **dimension** — discovered axes, metadata (folder, author,
date, length), influence, and any **semantic query you type** — can be placed on any **channel**
(color, size, x, y, z, scrubber), with a per-dimension **honest ⇄ rank** toggle (true magnitudes vs
even spread) and an invert flip.

The shell is a standard app (DaisyUI 5): a top **toolbar** of labeled menus, a **filter-chips row**
with a live visible-count, a docked **reading pane** (cards and regions), and a **theme picker**
(black/light defaults + more; the theme rides the shareable URL) — on mobile the toolbar and pane
become bottom sheets.

- **layout**: neighbor map · **axis scatter** (any dimensions on x/y) · **3D space** (the neighbor map in 3D, drag to rotate) · **3D axis scatter** (any dimensions on x/y/z) — the camera stays continuous across 2D↔3D
- **color** by region, any metadata, any axis, or a query · **size** likewise (default: influence) — the color menu doubles as the legend (click a row to isolate)
- **filters** compose: isolate a region or folder, text-find, scrub any scalar dimension — active filters show as chips, one click to clear
- **grain** slider — the nested region ladder from continents to towns; on-map labels declutter and *reveal as you zoom*, like a real map
- **tap a card** → its restatement, where it sits on each axis (ranked by extremity), nearest neighbors, and links to **both** the reader and the **original source** (so a shared map opens even without the reader login)
- **deck** — the whole corpus as a sortable/filterable list: the accessible, screen-reader parallel to the canvas
- **frontier** (`--frontier` corpora) — intra-corpus **citation edges** + **ghost** papers (cited but not in the corpus), placed near the work citing them, sized by citation count, click → arXiv
- **theme** light/dark, keyboard-operable throughout, `prefers-reduced-motion` honored
- **trajectory** (`STATE.md`) — where the corpus's attention moved over time (needs dated docs)

Build + serve it:

```sh
cp out/<name>/<name>.eido viewer/public/map.eido   # the pipeline's binary map (copied into the build)
cd viewer && bun install && bun run build    # -> viewer/dist/index.html (self-contained) + dist/map.eido
python3 -m http.server --directory dist 8000 # open http://localhost:8000
```

One build serves several corpora: **`?map=<name>.eido`** loads any sibling `.eido` next to `index.html`
(defaults to `./map.eido`) — e.g. drop `pathfinder.eido` in and open `?map=pathfinder.eido`.

**Every view is a link.** The URL mirrors the whole view — layout, every channel's dimension and
its honest/invert props, typed queries, filters, scrubber window, grain, and the open card — so any
view is shareable and a reload restores it. Deep-link
straight to a card with **`?card=<id>`** (e.g. `?map=pathfinder.eido&card=<id>`); the browser Back button
(and the mobile back gesture) steps out of the deck/detail and undoes navigation.

**One portable file, works offline.** `bun run singlefile [map.eido] [out.html]` inlines the map into the
viewer as one self-contained `.html` — no server, no separate data file. Email it, drop it on a disk, open
it offline; its `?card=` and view links still resolve from `file://`. (Verified by `bun run e2e/offline.ts`,
part of `bun run qa`.)

### The `.eido` seam

The pipeline emits `map.eido`: a gzipped binary of the **`MapContract`** (`src/schema.ts`). Numeric
arrays — coordinates, per-axis scores, the grain ladder, neighbor and citation lists — ride as
Float32/Int32 buffers (parsed straight into GPU attributes); strings and sparse metadata ride in a
JSON header. ~5× smaller than the JSON. `MapContract` is the **only** coupling between pipeline and
viewer: either side can change freely as long as both honor that (versioned) shape. `map-data.json`
is the same data, human-readable, for debugging — written only under `--debug-json`, because
serializing the whole contract as one JSON string exceeds the string limit on large corpora.

## Develop / verify

```sh
bun run qa        # the gate: tsc --noEmit + bun test (contract) + the viewer integration e2e
bun test          # deterministic contract tests (loadFolder, trajectory, deck, cardText, mapbin round-trip)
bun run typecheck # tsc --noEmit
bun run e2e/viewer.e2e.ts   # builds a synthetic .eido, serves the REAL viewer bundle, drives it in Chromium
```

The e2e is the parity net for the new viewer: it encodes a synthetic map to `.eido`, serves the
actual `dist/index.html`, and asserts interaction invariants (grain ladder, label-reveal-on-zoom,
legend isolate, drill, tap-to-open, frontier, theme, `?map=`) through a read-only `window.__eido()`
seam — real bundle, real browser, no mocks. Requires `cd viewer && bun run build` first.

## Status

`bun test` + `bun run typecheck` are green. Working end to end: the core pipeline
(discover · card · embed · project · viewer), the generic folder loader + CLI, resumable card runs
(cached by id), the deck-view reader, the trajectory report (`STATE.md`), the Semantic Scholar
citation frontier (`--frontier`), and fully-local runs via any OpenAI-compatible server.

**Positions come from the PCA projection, not the model** (see *The idea*). Every run reports how
much of the corpus's variation each axis explains and flags the *minor* axes (under 2%) in
`REPORT.md`, so you can tell a real dimension of your reading from a thin one.

Plan and open work live in `tk` (`tk show eid-vd9d`, `tk ready`) and [ROADMAP.md](ROADMAP.md).
