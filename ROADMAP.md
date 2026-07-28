# eidoscope roadmap 🔭

Single human-readable mirror of the plan. Source of truth is `tk` (epic `eid-vd9d`,
milestone `eid-qy2v`); run `tk show eid-qy2v` and `tk ready` for live state.

## North star

Turn **anyone's** corpus into an interpretable card-map. The moat is the discipline:
solid math **discovers** the axes (PCA + a real dimensionality/redundancy check), the LLM
only ever **labels and scores** them — it never invents the ontology. The card (each
document re-described on the discovered axes) is a concept bottleneck: legible coordinates,
not a raw text vector. Everything else — map, deck, telescope, trajectory — reads the deck.

## v1 = "real product" — Definition of Done (`eid-qy2v`)

A **polished, maintained OSS package**, telescope included. Done when, *measured not asserted*:

1. **Standalone** — a stranger runs `eidoscope ./their-folder` with their own key **or** a local
   OpenAI-compatible server (LM Studio, etc.); zero dependency on this machine (no local curare
   checkout, no `curare/.env`).
2. **Local path proven** end to end (embeddings already local; LLM → any OpenAI-compatible local
   server, e.g. LM Studio, by config).
3. **Honest output bar** — axis redundancy `< 0.3` (currently 0.25), summaries accurate, map legible.
4. **Telescope** — citation-frontier "ghost" papers work on a citation corpus.
5. **Docs** — a stranger-README + one bundled example corpus (`try it` = one command).
6. **Green gates** — `bun test` + `tsc` + the storybook, run by CI on push.
7. **Published** to npm as `eidoscope`.

## Tracks (ship-order — risk-first at the product level: "will a stranger get a good result?")

**1 · Trustworthy core** (the moat)
- ✅ Axis distinctness — one-call `labelAxes` (redundancy 0.39→0.25). `f5e1c3f`
- ✅ `eid-ileo` — redundancy guard + fidelity now reported every run + opt-in fidelity gate (validated: gate 0.3 → redundancy 0.27, fidelity 0.50). Deep-axis fidelity is corpus-bounded; measured not forced.
  CLI + test); ☐ deep-axis fidelity (still ~0.36) remains the harder half.

**2 · Standalone & installable**
- ✅ `eid-8hv4` — decoupled from curare: `@huggingface/transformers` + `ml-kmeans` used directly,
  config drops the curare path + `.env` fallback. **Gold-matched to curare** (embeddings cosine
  1.000000, clustering k+assignments identical) and a from-scratch folder run verified end-to-end.
  `bce2059`. *(Remaining before publish: gate the dev-only fixture absolute paths — folded into ship.)*
- ✅ `eid-l7z4` — verified **fully local** via LM Studio (gemma-4-12b @ 32k context): whole pipeline
  runs, no OpenRouter/curare. Documented (needs a capable model + ample context). Provider-agnostic.
- ✅ `eid-b2a9` — resumable card runs (cache by id) so a long run survives a crash.

**3 · Ship v1**
- ◑ `eid-kgui` — ✅ LICENSE + package.json + example corpus (24-doc, runs OOTB) + small-corpus robustness + README; ☐ `npm publish` (awaits explicit go — irreversible outward action).
- ✅ `eid-qesa` — CI: tests + typecheck on push.

**4 · Delight / included differentiator**
- ✅ `eid-ugn6` — frontier telescope: data (S2 edges/impact/ranked, live-verified) + ghosts (verified) + viewer (rings/edges toggles, QA’d) + `--frontier` wiring. The differentiator, done.

**Post-v1** (off the critical path): deck/spectrum readers, `eid-65ub` perf, `eid-dr7o` ✅ orbit crash.

## The standing loop — keep it honest, keep it improving

Every change is checked against **measurements, not vibes**, as regression gates:
- **axes**: cross-axis card-score redundancy (mean |r|) and fidelity to each PC — the quality gate
  the coherence filter never was. Target redundancy `< 0.3`.
- **viewer**: the storybook screenshots (`bun run storybook.ts`).
- **green**: `bun test`, `tsc --noEmit`.
- periodic gut check: *would I use it? would a stranger?*

A metric that, maximized, defeats the tool (e.g. faithfulness-to-full-text — see closed `eid-fd0e`)
is a **guardrail, not an objective**. Keep the distinction.
