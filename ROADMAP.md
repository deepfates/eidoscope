# eidoscope roadmap 🔭

Single human-readable mirror of the plan. Source of truth is `tk` — north-star epic `eid-vd9d`,
**v1 epic `eid-caza`**, far side `eid-8j5h`; run `tk show eid-caza` and `tk ready` for live state.

## North star

Turn **anyone's** corpus into an honest, interpretable, portable map you look *through*. The moat
is the discipline: solid math **discovers** the axes (PCA + a parallel-analysis check) and
**places** every document (its position is its projection); the LLM only ever **labels** poles and
**re-states** documents as cards — it never scores, positions, or invents the ontology. The
neighbor map is deliberately a *different* view: UMAP over the card vectors, readable neighborhoods
through the concept bottleneck. Axes and neighborhoods disagreeing is the instrument, not a bug.

## v1 (`eid-caza`) — the fluid honest grammar

Make the honest model fluidly transformable through one coherent direct-manipulation grammar, in
the portable carried-vectors regime, behind Source/Sink/Store seams so it grows to columnar scale
without a rewrite. Positioning: unbundle the hosted-SaaS map tools into an open, local-first,
pluggable UNIX-style instrument.

Shipped substrate (epic `eid-9h9j`, closed): one Dimension registry × channels (color/size/x/y/z/
scrubber), queries as first-class dimensions, per-dimension honest⇄rank + invert, one filter
primitive, the whole view serialized to the URL, honest axes end-to-end (raw PCA projections
carried in the `.eido`).

Build order (deps encoded in `tk`):

1. **Shell** (`eid-zjbh`) — real state management extracted from the one big component (channels
   and selection as model objects), and a chosen panel layout to replace the two floating chips.
   The layout candidates get decided by building and looking, not prose.
2. **Grammar coherence** (`eid-hsy3`) — naming, copy, and behavior consistency across every control.
3. **SELECT** (`eid-r8t6`) — draw a loop, hold a set, verbs appear. Explicit select-mode button;
   the set is materialized at gesture time (a lasso in 3D depends on the camera, so the *result*
   is portable, the gesture is not).
4. **DERIVE** (`eid-8139`) — query-by-example: a held set becomes a new dimension ("like these vs
   not"), same machinery as typed queries. **DESCEND v0** (`eid-nuwd`) — export a held set as a
   corpus, re-run the pipeline, open the child map (fluid in-browser descend is far-side).
5. **Seams** (`eid-ege1`) — Source/Sink/Store as real interfaces; separable-parts `.eido`;
   markdown-vault / dataset sinks.
6. **Scale swaps** (`eid-cl83`) — standard libs, measured on real corpora (`eid-bm01` supplies
   them): kill the JSON.stringify wall, shard the caches, truncated SVD, seeded runs, faster
   layout. Plus tests on the numerical core (PCA / parallel analysis / clustering / kNN — currently
   untested).
7. **Polish** (`eid-ef7e`) — craft pass once the grammar is whole.

Shipped since this plan was written: the DaisyUI shell (toolbar · filter chips · reading pane ·
themes), theme-derived map palettes, the extracted view model, SELECT (circle → held set that
explains itself → filter/export), exact Gram/EVD axis discovery (26× faster, bit-identical), seeded
determinism, ingest dedupe, one command-name-per-concept — and **THE BILATERAL** (epic `eid-yhj7`,
contract in `docs/ARCHITECTURE.md`): the viewer became an app (in-tab ingest with folder + HuggingFace
connectors, in-app DESCEND, save/open `.eido` incl. FSA in-place, export menu), the `.eido` became a
pure document (`docs/EIDO-FORMAT.md` + anti-rot test), WebGPU in-page embedding (17× measured), OPFS
persistent caches, views carried in the file, and the competitive study recorded (`eid-zz8n`, closed).
Landed through adversarial review (all codex-approved, shipped live): the Web-Worker engine (tab
never freezes; one-format v2.2 container), honest kNN (exact WebGPU whenever a GPU exists;
calibrated hnswlib-wasm as the no-GPU fallback; the data-scale crossover deleted), ingest reachable
from any app state (`eid-9rdy`), and the similarity-arranged theme-derived color system
(`eid-zsij` — engine-minted per-card color coordinates carried in the `.eido`; region/categorical
hues from member centroids with exact order-preserving separation; theme-derived scalar/diverging
ramps; tree hues, the spread-k region path, and the Viridis carve-out deleted).
Also landed: arbitrary per-row metadata columns (`eid-xmf0` — one generic typed store in the
contract and the v2.2 container, threaded ingest → `cols` → dimensions in the `mcol:` namespace;
the HuggingFace connector carries every non-text column; its full-corpus acceptance run is still
outstanding) and the deletion of the last size-refusal (the page states honest estimates and
proceeds at any corpus size, never refuses).
Queued next, in triage order: run durability (`eid-ext6` — a long paid ingest must survive a crash;
prove cache survival free before spending again), folder-side metadata extraction (`eid-ovsw`, so
metadata isn't a HuggingFace-only privilege), the Pitchfork acceptance run (`eid-xmf0`/`eid-6bd2`),
the matklad QA gate rework (`eid-6egl`), then the micro-UX live items (`eid-kzv2`). The interface
era's brief lives on `eid-rcm8` (ingest as workspace; provider/compute as user choices) and
`eid-ef7e` (tools not buttons; the analogy field).

Recovered from the full conversation history and now tracked (things asked for that had fallen out
of the record): the micro-UX inventory (`eid-kzv2` — multiple filter slicers, a real status bar,
full region names on hover, card-hover content, symbol toggles), the view-state store architecture
question (`eid-thbs`), auto-deploy so the live URL is always current (`eid-vkep`), export sinks
beyond `.eido` (`eid-ncrq`), justifying the grain ladder from the data rather than hand-carved
constants (`eid-iw04`), the competitive feature study (`eid-zz8n`), named corpus targets
(`eid-6bd2`), and mobile animations that jump instead of easing (`eid-aw7x`).

Open design forks (decide by looking at built candidates): where selection verbs appear (on-map vs
inspector) · what a card looks like as you zoom · deck as drawer vs modal.

## Far side (`eid-8j5h`)

Multimodal ingest, XR rendering, hosted/collab, 55M-scale tiling, npm publish, fancy syntheses
(gaps/diffs/paths). (In-browser DESCEND shipped to v1 — it graduated off this list.)

## The standing loop — keep it honest, keep it improving

Every change is checked against **measurements, not vibes**: axis redundancy/fidelity gates,
`bun run qa` (tsc + viewer typecheck + svelte-check + unit + e2e + offline), real-browser
verification of interaction changes, and the periodic gut check: *would I use it? would a
stranger?* A metric that, maximized, defeats the tool is a guardrail, not an objective.
