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
Where the loop stands, measured on the live 19,299-review map (in-page stamps, not polling): arrive
6.9s (transfer-bound — a 40MB already-compressed file, see `eid-ncrq`), a card opens in ~100-190ms,
holding a lassoed set 74ms, the set explaining itself 70ms, derive acknowledging in 16ms and
finishing in 74ms. Every step of the stranger's loop except arrival is under 200ms. The gate runs in
339s (was 628s). See `docs/VERIFY.md` for how those numbers are taken and why the earlier ones were
wrong.

Also closed since: run durability, gated by an e2e that kills the browser and re-ingests
(`eid-ext6`); folder-side metadata extraction, so metadata is no longer a HuggingFace-only privilege
(`eid-ovsw`); the Pitchfork acceptance run — 19,299 reviews mapped for $80.96, live, with genre,
score, artist and author riding as placeable dimensions (`eid-xmf0`); scale swaps, closed by
measurement under the ≤100k ruling (`eid-cl83`).

Micro-UX sweep since (`eid-kzv2`, `Hac-2hjp`, `Hac-u1cn`): region labels no longer draw through each
other on a narrow screen (the edge nudge used to run after the declutter had already cleared the
overlap), and the 3D views' pile-up (`Hac-u1cn`) was closed by building rather than ruled on — degree
of interest plus screen-space thinning plus hysteresis, margins picked by measuring a real 120° orbit
(7 labels showing, none overlapping, where all 18 used to draw on top of each other).
Earlier in the same sweep: a map filtered down to nothing now says so and offers the
way out, and stops drawing region labels over the empty space; a restored view naming a dimension this
map does not have reports it instead of silently drawing the default; and the toolbar's fold now decides
on measured overflow rather than an estimate that under-counted by 53-94px and let controls overlap. Pole
labelling in the reading pane and in the axis legend was already correct — verified live rather than
closed on faith. Each is gated by a new assertion in the viewer suite.

WHAT REMAINS FOR v1 — corrected 2026-08-12 after an audit of the full conversation record. This
paragraph used to read "taste and four design rulings, all waiting on deepfates, none to be built
unilaterally." **That was wrong, and it froze a week of buildable work.** Two of the four are
specifications he already delivered, written down here as though they were questions he had failed
to answer. The honest split:

**Ready to build now, no ruling needed.**
- **The compute is the reader's choice** (`eid-rcm8`) — he specified it on 2026-08-10: an in-app
  model picker (OpenRouter, LM Studio, any OpenAI-compatible endpoint), a choice of embedder and
  where it runs, and the measured time-and-spend estimate recomputed per configuration so the
  tradeoff is visible at the moment of choosing. `src/provider.ts` already takes any endpoint and
  model; the app has no picker at all. Only the interface is missing.
- **A million documents fail well** (`eid-jgjb`) — his user story is plain: fail gracefully, ideally
  keep working with eventual consistency. State the estimate in hours and dollars up front, covering
  the stages that will fail; checkpoint into a partial `.eido`; when a stage cannot finish in this
  host, say so and name the CLI twin. One real judgement is left inside it — at which measured wall
  the app hands off, and whether it says so before the spend or at the failure.
- **Separable-parts export** (`eid-ncrq`, first half) — writing the three strata as distinct files is
  his verbatim ask and changes no contract, because export is additive.
- **The factoring cleanup** (`eid-sh90`) — he asked directly whether the code was well designed; the
  answer was "the engine yes, the shell no," the plan was settle-semantics-then-refactor, the
  semantics got settled in `c39cfc8`, and the refactor never started. `App.svelte` is 1,653 lines,
  two embedder wrappers still wrap one package (against his explicit ruling), and `encode.ts` still
  holds six mutable palette globals the colour redesign was meant to retire.

**Genuinely his, and correctly waiting.**
- **Separable-parts import** (`eid-ncrq`, second half) — whether a `.eido` may be *opened* in parts so
  a map mounts from geometry while cards stream in. This changes the format's contract, and it is
  the real answer to the 6.9s arrival (which is pure transfer; gzip makes the file bigger).
- **The shell as an instrument of tools** (`eid-ef7e`) — parked by him in his own words, "we don't
  have to fix this right now… something to think about later." Waiting on his appetite, not his
  decision. Also holds the analogy field and whether an introduction should be a modal at all.
- **The e2e consolidation** (`eid-6egl`) — the measurement that justified the rewrite evaporated once
  the real cost turned out to be one bug (628s → 339s, same assertions). The proposal on the ticket
  is to keep the suites and add the walk as a ninth.

The lesson this paragraph is now carrying: **a specification is a build order, not a question.** When
he states what something must do, that goes on the board as work. Ask him only where two defensible
answers would send the build in different directions — and ask it as a question, at the moment it
blocks something.

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
