# The relatedness eval — is the map actually right?

Everything else eidoscope measures about a map is *internal*: determinism, kNN recall, 2D↔3D agreement,
layout-versus-layout neighbourhood preservation. All of those can be perfect while the map is nonsense,
because they only ever compare the instrument to itself. Two of the three externals we have leaned on
before were known-biased (citation graphs favour full text; folder structure favours format), and the
third was an LLM triplet judge — an opinion produced by the same family of modelling the map is made of.

`bin/eval-relatedness.ts` is the answer to that: it scores a construction against **external verifiers** —
labels a human or an institution attached to these documents for their own reasons, before we embedded
anything.

```
bun run eval:relatedness                                   # every corpus with a verifier, k=10
bun run eval:relatedness -- out/pitchfork/pitchfork.eido   # one corpus
bun run eval:relatedness -- <eido> --layout landmark=/tmp/xy.json   # score an ALTERNATIVE layout
bun run eval:relatedness -- <eido> --fetch                 # (re)build the external verifier sidecars
bun run eval:relatedness -- <eido> --k 5 --json report.json
```

It is **not** in `qa`. It is a measurement, not a gate: it tells you what a change did to the map's
agreement with the world, and a human decides whether that is acceptable. Wiring it as a pass/fail would
turn it back into the thing it replaces.

## The measure

For each (corpus × verifier × space):

- **precision@k** — of a card's *k* nearest neighbours in that space, what fraction share at least one of
  its verifier labels (unlabelled neighbours are dropped from the denominator; `cov` reports how much of
  the corpus carries the label at all).
- **baseline** — the same test over 200,000 seeded random pairs of labelled documents in that corpus.
- **lift** — observed ÷ baseline. **The lift is the finding; the absolute number means nothing on its
  own.** A 9-value genre label gives ~0.37 by chance on Pitchfork; a 9,360-value artist label gives
  ~0.0014. Comparing 0.69 to 0.056 across those two rows would be meaningless.

Scalar verifiers (a review score) are scored as **mean |Δ| between neighbours** against mean |Δ| between
random pairs, and their lift is baseline ÷ observed, so "bigger is better" holds in both metrics.

**Spaces.** `cards` is the card-vector neighbourhood — the map's actual substrate, recomputed from the
`.eido`'s own vectors through the product's kNN seam and cross-checked against the file's stored `nbr`
graph (100% edge agreement on every shipped corpus, so the eval is scoring the map the file describes).
`xy` is the 2D layout — what a reader actually looks at. `--layout name=file.json` scores any alternative
placement of the same corpus, which is how one construction is compared to another on identical verifiers.

**Nothing is blended.** Every corpus × verifier × space is its own row, on purpose: each verifier leans
somewhere different, and an average of biased numbers is a number whose bias you can no longer name.

**There is no LLM judge in the harness**, also on purpose. Use one as a smoke test if you like; it can
never be the verdict here, because its opinion is downstream of the modelling under audit.

## The verifiers, and what each one is biased toward

| corpus | verifier | what it is | biased toward |
|---|---|---|---|
| pitchfork (19,299) | **genre** | Pitchfork's editorial genre tag (9 values, multi) | Coarse (baseline 0.37) and topical: genre words occur naturally in the review prose (measured: a genre word appears in 60.7% of restatements, 1.0% of titles). **The label itself was never visible to the card model** — `parseSourceFile` splits frontmatter from body and only the body plus the title is sent (`corpus-core.ts:37-39`, `card.ts:31`), so genre/score/author are lifted into the metadata store *before* carding. Corrected 2026-08-12: this row previously claimed the label was "in the source frontmatter the card model read", which the code contradicts. The friendliest verifier here, but honestly earned. |
| pitchfork | **artist** | same-artist pairs (9,360 artists) | Very sparse → baseline 0.0014, so lifts are large by construction. **The weakest verifier here, and the one to distrust:** the corpus title is literally `Artist — Album`, the title is the first thing in the embedded card text, and the artist is named throughout the review. So this row rewards proper-noun retention at least as much as musical relatedness. Treat 40.9× as an upper bound on real artist relatedness until a title-stripped re-embed says otherwise. |
| pitchfork | **author** | same reviewer | A staffing fact, not a music fact — but critics have beats, so it partly re-measures genre and era. **The byline was NOT visible to the card model** (frontmatter is stripped before carding), and the restatement signature explicitly demands "one neutral, uniform voice — the same voice for every author, source, and format". So a lift here is evidence the normalization is leaking critic voice, not evidence of a label leak. |
| pitchfork | **score** | the 0–10 verdict (scalar) | The only verifier with no topical channel at all. A map is *not* expected to group by it; lift ≈ 1 is a fact about music criticism, not a defect. |
| simple-wikipedia-400 (282) | **wikicat** | shared Simple-Wikipedia category, maintenance categories filtered out | Editor-curated, hierarchical, and mixes topic ("Cities in Switzerland") with biographical bookkeeping ("1933 births"). **Not present in the local article text** (the vault article is a stub), so this is genuinely outside the map's inputs. |
| simple-wikipedia-400 | **wikidata_p31** | Wikidata "instance of" (human / city / film / …) | Entity *type* from a separate knowledge base. Extremely coarse — "human" swallows a third of any Wikipedia sample (baseline 0.20) — so it credits sorting people from places, not people from each other. Also outside the map's inputs. |
| openrouter-model-cards (456) | **vendor** | the source folder | **The known-bad control, kept in deliberately.** The vendor name is in the title, the prose and the frontmatter, and vendors write to a house template. This is "folders favour format", quantified instead of assumed. |
| openrouter-model-cards | **price_tier** | OpenRouter's prompt price, log-bucketed, from the registry metadata record | Never appears in the card document, so it is real outside evidence — but coarse (5 buckets, baseline 0.23), only 47% covered, and correlated with size and recency, so it partly re-measures "frontier vs small". |
| open-library-300 (300) | **subject** | librarian-assigned subject headings | **Weak independence, flagged:** the subjects are printed in the rendered document the card model read. Long-tailed, so its baseline is near zero and its lifts flatter. |
| aesop-fables (285), graham-essays (233) | — | *no external verifier exists* | Reported as unmeasured. Not passing — unmeasured. |

Sidecar verifiers (the ones fetched from Wikipedia, Wikidata, or a vendor registry) are cached under
`eval/verifiers/<corpus>.<verifier>.json` and committed, so re-runs are offline and reproducible.
`--fetch` is the only thing that touches the network or the source directories.

## Baseline report — 2026-08-10

Shipped `.eido` files as of `out/` on 2026-08-10; k = 10; 200,000 random pairs; card kNN exact-GPU
(recall 1.0), layout kNN over the file's own `xy`.

| corpus | verifier | space | n | cov | metric | observed | baseline | lift |
|---|---|---|---|---|---|---|---|---|
| pitchfork | genre | cards | 17,182 | 89% | prec@10 | 0.6926 | 0.3740 | **1.85×** |
| pitchfork | genre | xy | 17,181 | 89% | prec@10 | 0.6385 | 0.3740 | 1.71× |
| pitchfork | artist | cards | 19,293 | 100% | prec@10 | 0.0562 | 0.0014 | **40.9×** |
| pitchfork | artist | xy | 19,293 | 100% | prec@10 | 0.0121 | 0.0014 | 8.78× |
| pitchfork | author | cards | 19,299 | 100% | prec@10 | 0.0484 | 0.0120 | **4.03×** |
| pitchfork | author | xy | 19,299 | 100% | prec@10 | 0.0285 | 0.0120 | 2.37× |
| pitchfork | score | cards | 19,299 | 100% | mean\|Δ\| | 1.2409 | 1.3297 | 1.07× |
| pitchfork | score | xy | 19,299 | 100% | mean\|Δ\| | 1.3011 | 1.3297 | 1.02× |
| simple-wikipedia-400 | wikicat | cards | 274 | 97% | prec@10 | 0.1726 | 0.0505 | **3.42×** |
| simple-wikipedia-400 | wikicat | xy | 274 | 97% | prec@10 | 0.1642 | 0.0505 | 3.25× |
| simple-wikipedia-400 | wikidata_p31 | cards | 266 | 94% | prec@10 | 0.4574 | 0.1956 | **2.34×** |
| simple-wikipedia-400 | wikidata_p31 | xy | 266 | 94% | prec@10 | 0.4189 | 0.1956 | 2.14× |
| openrouter-model-cards | vendor | cards | 456 | 100% | prec@10 | 0.5754 | 0.0577 | **9.97×** |
| openrouter-model-cards | vendor | xy | 456 | 100% | prec@10 | 0.5638 | 0.0577 | 9.77× |
| openrouter-model-cards | price_tier | cards | 213 | 47% | prec@10 | 0.3462 | 0.2265 | **1.53×** |
| openrouter-model-cards | price_tier | xy | 215 | 47% | prec@10 | 0.3185 | 0.2265 | 1.41× |
| open-library-300 | subject | cards | 285 | 95% | prec@10 | 0.4552 | 0.1637 | **2.78×** |
| open-library-300 | subject | xy | 285 | 95% | prec@10 | 0.4048 | 0.1637 | 2.47× |

*aesop-fables and graham-essays have no external verifier and are therefore unmeasured.*

### What this baseline says

1. **The card bottleneck carries real relatedness.** Every verifier that could show signal does, on every
   corpus, including the two that were never visible to the pipeline at all (Wikipedia categories 3.4×,
   Wikidata type 2.3×). The map is not decorative.
2. **The one verifier the map does not track is `score` — 1.07×, i.e. essentially random.** Neighbouring
   reviews are as far apart in verdict as any two reviews. That is the eval doing its job: a reader who
   expects the Pitchfork map to separate good records from bad should be told plainly that it does not,
   and the map has no business implying otherwise.
3. **The projection to 2D is where relatedness is lost, and the loss is severe on fine structure.**
   Same-artist lift falls 40.9× → 8.78× (−79%) going from the card vectors to the layout the reader looks
   at; reviewer 4.03× → 2.37×. Coarse structure survives (genre 1.85× → 1.71×). The neighbour list beside
   a card is a far better guide to what is related than the position of the dot.
4. **`vendor` on the model cards, at 9.97×, is the control behaving exactly as suspected** — a
   format/boilerplate signal, and the reason folder agreement must never be quoted as evidence of quality
   on its own.

## The first question this was built to answer: does landmark layout lose real quality?

Branch `agent/landmark` (eid-cl83) lays out `s` landmark points exactly and places the rest by
inverse-distance weighting. It reported 10-NN preservation *against the exact layout* of 0.023 at s = n/10
versus 0.063 for exact — but that compares a layout to another layout, which cannot distinguish "worse" from
"different".

Measured here on the same 19,299 Pitchfork card vectors, laid out by that branch's own
`projectAndCluster` at s = n, n/2, n/4, n/10, and scored against the four independent verifiers
(k = 10; the same ordering holds at k = 5):

| space | genre lift | artist lift | author lift | score lift |
|---|---|---|---|---|
| cards (the substrate) | 1.85× | 40.9× | 4.03× | 1.07× |
| xy — exact fit | 1.69× | 7.95× | 2.30× | 1.02× |
| xy — landmark s = n/2 | 1.63× | 4.86× | 2.14× | 1.02× |
| xy — landmark s = n/4 | 1.57× | 3.92× | 1.94× | 1.02× |
| xy — landmark s = n/10 | 1.50× | 3.21× | 1.73× | 1.01× |

**The answer: yes, landmark layout loses real quality — but it is a graded loss, and the projection to 2D
already costs several times more than landmarking does.**

- The loss is monotone in how much of the map is interpolated and it is visible to verifiers that never
  saw the layout, so it is not an artefact of comparing one layout to another. At s = n/10 a reader's
  10 nearest dots are 11% less likely to share a genre (0.632 → 0.560) and **60% less likely to be by the
  same artist** (7.95× → 3.21×).
- What a reader *sees at a glance* — the coarse genre/vendor-scale grouping that gives a map its shape —
  survives landmarking well: 1.69× → 1.50× is a real but undramatic thinning. What degrades badly is the
  fine "these two dots are the same artist" structure, which is exactly the structure a reader is most
  likely to trust and least able to check.
- Both layouts are far less informative than the card-vector neighbourhoods they came from (artist 40.9×
  → 7.95× → 3.21×). The landmark decision is therefore a second-order choice inside an already lossy
  view, and it should be made on cost, not defended as free.

## How much of a lift is just the proper noun? — 2026-08-12

`artist` is the row most vulnerable to leakage: the Pitchfork corpus title is literally `Artist — Album`,
`cardText` puts the title first, and the restatement names the artist throughout. So 40.9× could be
measuring name retention rather than musical relatedness. Falsified by re-embedding one fixed 4,000-card
sample three ways with the same MiniLM and scoring same-artist prec@10 on each.

| card text | prec@10 | lift | vs shipped |
|---|---|---|---|
| as shipped (title first) | 0.0182 | **23.60×** | — |
| title removed | 0.0148 | 19.19× | −19% |
| **artist name masked everywhere** (title, restatement, axis notes) | 0.0078 | **10.10×** | **−57%** |

**The name is 57% of the signal. The other 43% is real: with the artist unnameable in 99.2% of cards, a
reader's ten nearest dots are still 10× likelier than chance to be the same artist.** That is the card
bottleneck recognizing an artist from described sound alone — the strongest evidence so far that it
carries substance and not just vocabulary.

Read the sample lifts only against each other, never against the 40.9× in the baseline table: 4,000 cards
is a sparser neighbourhood with its own baseline (0.00077 vs 0.0014 at full corpus).

Two reasons 10.10× is a **lower** bound, both worth saying out loud: the mask replaces the name with the
token `ARTIST` in almost every card, which mildly homogenizes the corpus; and it blanks every name word
over three characters, so an artist called *Girls* or *Life* loses real content along with the proper noun.
Nothing here inflates the surviving lift.

Reproducing: decode `out/pitchfork/pitchfork.eido`, rebuild `cardText` per `geometry.ts:111` for a seeded
sample, apply the three treatments, embed each with `poolEmbed`, and brute-force cosine prec@10 against the
`artist` metadata column with a 200,000-pair baseline drawn from the same sample. (Scratch harness, run and
discarded per CLAUDE.md; the numbers are the artefact.)

Reproducing the landmark rows: on `agent/landmark`, call `projectAndCluster` from `src/geometry.ts` with
`{ knn: nodeKnn, knnTo: nodeKnnTo, layoutApprox, landmarks: s }` over the unit-normalized `vectors` of
`out/pitchfork/pitchfork.eido`, dump each `.xy` to JSON, then score with
`--layout exact=… --layout tenth=…`. (The regenerated exact layout scores within noise of the shipped one
— 1.69× vs 1.71× on genre — the small gap being that the shipped map was fitted on the float32 embeddings
while a rerun from the file uses their f16-quantized copies.)
