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

- **solid** (deterministic math) **discovers** the axes — PCA on the embeddings, plus a
  parallel-analysis honesty check so it can only keep axes that beat noise. It never lets the
  model invent structure.
- **fluid** (an LLM, via [Ax](https://github.com/ax-llm/ax) signatures) only ever **labels** the
  axes' poles and **scores** each document on them. Name and place, never originate.

That constraint — *fluid intelligence may name and place, never invent the ontology* — is why the
map isn't a hallucinated cartoon of three data points. It's the moat.

## Shape

```
documents ──▶ discover + label axes ──▶ card each doc ──▶ embed cards ──▶ project ──▶ deck
              (PCA + parallel-analysis    (Ax signature,   (curare)      (umap-js)   (JSONL)
               + Ax labelAxis)             provider-agnostic)                          │
                                                                                       ▼
                                                                            readers: map · deck-view
```

The **deck** (one card per line, JSONL — inspectable, appendable) is the asset. The map viewer,
the card/spectrum view, the citation frontier, and the trajectory report are all *readers* of the
deck, not the app.

Built on **curare** (local embeddings) and **[Ax](https://github.com/ax-llm/ax)** (DSPy for
TypeScript — the gorm signatures, with validation, retries, traces, and any OpenAI-compatible
provider incl. local servers like LM Studio, so cloud or local is one line of config).

## Use it

```sh
bun install
bun run src/cli.ts example           # try it: a bundled 24-doc demo corpus across domains
bun run src/cli.ts <folder>          # any folder of .md/.txt -> deck.jsonl + map-data.json + eidoscope.html (+ STATE.md if dated)
bun run src/cli.ts <folder> --limit 200
bun run src/cli.ts <folder> --frontier   # also pull the citation frontier (arxiv corpora)
open eidoscope.html
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
**enough context** (labeling all axes in one call needs ~8k+; 32k is safe). llama.cpp / vLLM work
the same way. Verify a run's axes are actually distinct: `bun run src/redundancy.ts map-data.json`
(target mean |r| < 0.3 — small corpora and weak models will fail it, honestly).

## In the viewer

- **layout**: neighbor map (MDE) · **axis scatter** (position by any two discovered axes) · **3D orbit**
- **color** by region or any axis · **size** by influence (hub-degree) · click a card → its neighbors
- **deck**: the cards as a reader — title, core, region, and the 3 axes each most commits to;
  sort by an axis to read the corpus as a spectrum
- **trajectory** (`STATE.md`): where the corpus's attention moved over time (needs dated docs)

## Develop / verify

```sh
bun test          # deterministic contract tests (loadFolder, trajectory, deck, cardText)
bunx tsc --noEmit # typecheck
bun run storybook.ts   # drive the viewer in headless Chromium -> story/*.png + a shareable gallery.html
```

## Status & how to resume

The plan and the definition of "done" live in **[ROADMAP.md](ROADMAP.md)** (mirrors `tk` epic
`eid-vd9d` / v1 milestone `eid-qy2v`; `tk ready` for the live frontier).

v0. Ported from the prototype in `../../../readwise/triangulation` (its `runs/main` deck is the
golden fixture, reproduced). `bun test` + `tsc --noEmit` are green.

**Done:** core pipeline (axes · card · embed · project · viewer), generic folder loader + CLI,
deck-view reader, trajectory (`STATE.md`), faithfulness metric + baseline.

**Validated (risk resolved):** the optimization bet. A `faithfulness` metric (does a card preserve
its document's true full-text neighborhood) baselines at **27.8% / 38× random**; an A/B probe
(`src/opt-probe.ts`) showed prompt changes move it ~3pts *and* a hand-tuned variant regressed — so
an automated optimizer (Ax GEPA against the metric) is warranted. That's the next build.

**Open work** — all tracked in `tk` (run `tk show eid-vd9d`, `tk ready`):
- `eid-fd0e` — build the GEPA optimizer loop (de-risked; plan is on the ticket).
- `eid-ugn6` — frontier plugin (Semantic Scholar citation telescope).
- `eid-b2a9` — resumable card runs (cache by id).
- `eid-8hv4` — publish-decoupling: use `@huggingface/transformers` + `ml-kmeans` directly instead
  of the local curare checkout (curare is deliberately pre-release), and drop the fixture paths.
- `eid-65ub` perf · `eid-dr7o` orbit-hint bug · `eid-qesa` CI.
