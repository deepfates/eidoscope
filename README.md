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
provider incl. Ollama, so cloud or local is one line of config).

## Status

v0. Being ported from the working prototype in `../../../readwise/triangulation` (its
`runs/main` deck is the golden fixture we build against). Plan + dependencies tracked in `tk`
(epic `eid-vd9d`). Optimization — tuning the card signature so its geometry matches the measured
structure — comes *after* it reproduces the fixture.

```sh
bun install
bun run check:card    # prove one card works as an Ax signature
```
