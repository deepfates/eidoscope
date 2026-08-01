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
  axis's poles and writes a short **note** per document. It names; it never scores or positions.

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
(target mean |r| < 0.3 — small corpora with little conceptual spread will fail it, honestly).

## In the viewer

- **layout**: neighbor map (MDE) · **axis scatter** (position by any two discovered axes) · **3D orbit**
- **color** by region or any axis · **size** by influence (hub-degree) · click a card → its neighbors
- **deck**: the cards as a reader — title, core, region, and the 3 axes each most commits to;
  sort by an axis to read the corpus as a spectrum
- **trajectory** (`STATE.md`): where the corpus's attention moved over time (needs dated docs)

## Develop / verify

```sh
bun test          # deterministic contract tests (loadFolder, trajectory, deck, cardText)
bun run typecheck # tsc --noEmit
bun run storybook.ts   # drive the viewer in headless Chromium -> story/*.png + a shareable gallery.html
```

## Status

`bun test` + `bun run typecheck` are green. Working end to end: the core pipeline
(discover · card · embed · project · viewer), the generic folder loader + CLI, resumable card runs
(cached by id), the deck-view reader, the trajectory report (`STATE.md`), the Semantic Scholar
citation frontier (`--frontier`), and fully-local runs via any OpenAI-compatible server.

**Positions come from the PCA projection, not the model** (see *The idea*). Every run reports how
much of the corpus's variation each axis explains and flags the *minor* axes (under 2%) in
`REPORT.md`, so you can tell a real dimension of your reading from a thin one.

Plan and open work live in `tk` (`tk show eid-vd9d`, `tk ready`) and [ROADMAP.md](ROADMAP.md).
