# Working on eidoscope

This file is the contract for anyone building here — human or agent. It is short on purpose.
Read it before you touch the code. `docs/COMMANDS.md` is the command-level source of truth;
`ROADMAP.md` mirrors the plan; `tk` (epic `eid-caza`) is the live board.

## What we are building

An instrument that turns any corpus into an **honest, holdable, interrogable, portable map you own**.
One `.eido` file = one chosen set = a library compressed into a gem you can hand someone.

**The map is the payload.** The card is a normalized, readable window onto one document; the value is
that a heterogeneous set becomes comparable *to itself* in a space a person can see.

## The discipline (non-negotiable)

**Solid math discovers and places; the fluid LLM only names.**
PCA (with a parallel-analysis significance check) finds the axes; a document's position on an axis
*is* its projection — calibrated, reproducible, exact. The model labels poles, re-states each
document as a card, and writes placements. It never scores, positions, or invents the ontology.

**The concept bottleneck is the point.** Geometry is built from the interpretable cards, never routed
around them to raw full-text to buy a better number. Axes come from full-text PCA; the neighbor map
comes from UMAP over card vectors. Those two views *differ on purpose* — that difference is the
instrument, not a bug to reconcile.

**No imposed ontology.** No hand-carved cutoffs, magic numbers, or tidy-looking constants standing in
for structure. If a parameter isn't justified by the data, it's a bug with a nice haircut.

## The interaction law

> Concrete things do not move underneath you unless you move them. One action changes one thing.

Creating an axis does not also change the color. Changing the projection does not also jump the
camera. Opening a panel does not resize the map. When you catch yourself shipping an incidental
side-effect, that's the law being broken — fix it, don't document it.

The grammar it protects: **Dimensions** (discovered axes · metadata · queries · derived) are placed on
**Channels** (color · size · x · y · z · window · sort), with per-dimension props (honest⇄rank,
invert). **Filters** are declarative predicates that AND together. A **Selection** is a frozen set of
cards. Operators — QUERY, SELECT, DERIVE, DESCEND, grain — all produce or consume those same objects.
**Every view is a URL.**

## How we work

- **Look, don't imagine.** Verify in a real browser with real gestures on real corpora. A claim you
  didn't watch happen is a guess. Screenshots and measurements beat reasoning about what should be.
- **Libraries over invention.** Thin glue around thick, battle-tested code. The invention budget is
  spent on the grammar and the seams — never on re-rolling a dropdown, a slider, or an SVD.
- **Finish; don't defer.** Solve the problem instead of filing a ticket to dodge it. Done means the
  old path is deleted, not that the new one works alongside it.
- **No one-off scripts, smoke tests, or side projects.** Real software, professionally. If a script
  is worth running twice, it belongs in `bin/` or the CLI with a test.
- **No fake choice points.** With a recommendation in hand and a reversible action, act and report.
- **Measure before you claim.** Costs, timings, and quality numbers get measured, not estimated.
- **Every increment: green and committed.** `bun run qa` (types · viewer types · svelte-check · unit ·
  e2e · offline) passes before anything merges, and the merger drives the app themselves afterward.

## Where things live

```
src/            pipeline: ingest → embed → discover axes → card → embed cards → project → emit
viewer/src/     the reader: model.svelte.ts (view state) · deckmap.ts (renderer) · App.svelte (shell)
docs/COMMANDS.md   every command: verb · object · scope · bindings · result
ROADMAP.md      the plan, mirroring tk epic eid-caza
test/ e2e/      the gate — `bun run qa`
```

The pipeline and the viewer are coupled by exactly one thing: the `MapContract` in `src/schema.ts`.
Either side may change freely as long as both honor it.
