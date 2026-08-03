# eidoscope viewer — living product critique

The honest, answerable account of what's wrong with the viewer *as a product a person receives and uses* —
not a ticket list I close, a standing record I'm accountable to over time. Kept in the repo on purpose.

**Method (the thing I got wrong before):** judge each screen as an artifact a *stranger* opens cold — what is
this, whose, can I act on it, can I hand it on. Walk each journey below and try to *break* it, live in a real
browser (not static screenshots — the feel is where it lives). Score "does this serve the journey," never
"is the ticket closed." Be the harshest critic of my own work.

**Two hard principles (do not violate):**
1. **Never distort discovery.** The geometry shows the *pure dimensionality* of the corpus so a person can
   gestalt the signal without reading everything. If the centre is tangled because those documents are genuinely
   that close, that is *truth*, not a bug — the reading tool is zoom / isolate / a concept-bottleneck lens, never
   de-crowding the projection or anything else that changes *what gets discovered*. Fixes may only touch how the
   honest structure is *shown and read*, never the structure itself.
2. **Test hypotheses across multiple datasets before concluding anything is a defect.** One corpus isn't evidence.
   Pull several diverse markdown corpora (HuggingFace, GitHub repos, docs) — the cheap `--embed raw` path skips
   the LLM so layout/readability questions can be checked across many corpora fast — and see if a "problem" is
   consistent or just this data.

**The through-line:** eidoscope is good at *finding* the forms and underbuilt at *showing* them. The discovery
is real; it breaks at the two moments that matter most to a person — the instant a stranger opens the file
(it can't say what it is), and the dense center (where the structure dissolves into unreadable, colour-repeating
mud). Most findings below are symptoms of that one gap.

Severity: 🔴 breaks the core promise · 🟠 real friction · 🟡 rough/unpolished · ⚪ unverified (must study live)
Status: `open` / `fixing` / `done`(with how it was verified) / `wontfix`(with reason)

---

## J1 — a stranger opens the file cold
- 🔴 `open` **No identity or provenance.** The header says "eidoscope · 13830 cards"; nothing says *Pathfinder 2e
  SRD*, who made it, when, or from what source. A file that can't introduce itself fails at step one. → the map
  must carry a title/source/date/count (pipeline emits it into the `.eido`; viewer shows it in the header + intro).
- 🟡 `open` The intro modal ("the forms of the corpus") is generic — same for every corpus. It should name *this* one.

## J2 — hand the file to someone / link it out
- 🟠 `open` A shared view links (via `?card=` etc.) but the *file itself* has no canonical identity/title in the tab
  or a share affordance. Passing it around loses all context.
- ⚪ `open` Untested: does a passed-around single `.html` file actually work offline (embedded data), and do its
  `?card=` deep-links resolve without a server? Must verify.

## J3 — follow a card out to its source
- 🟢 dual links (reader + original source, labelled by site) are in and verified. Re-check they render for cards
  with *missing* metadata (no author/date/source) without breaking the panel. ⚪ `open`

## J4 — study the corpus along an axis / facet
- 🔴 `open` **Colour can't be decoded at high cardinality.** 34 folders, ~8 palette colours → they cycle; "Feat
  Feature Effects" is the same blue as "Equipment". You cannot read the map by colour, which is the whole promise.
  → (a) generate more perceptually-distinct colours; (b) real answer: make facet legend rows **isolate on click**
  (dim everything but that folder) — you study one facet at a time instead of decoding 34 colours at once.
- 🟠 `open` Facet/axis legend rows are **not interactive** (only region rows isolate). Studying a facet is a core
  use case with no direct affordance.
- 🟡 `open` Axis names are long and truncated everywhere — dropdowns ("axis: Technical Optim…"), poles. Studying an
  axis means constantly not being able to read its name.
- 🟡 `open` 7 of 16 axes are "weak" (below the variance floor); the main UI only marks them with a faint "~". A
  user has no clear sense of which axes are worth studying vs noise.

## J5 — read the map / see the structure
- ⚪ `open` **Is the dense center actually a problem, or is it honest density?** (I earlier called it a defect — likely
  wrong.) If those cards are genuinely that similar, a tight core is *true*, and the fix is reading-by-zoom, not
  distorting the layout. The real question to test **across several datasets**: when you zoom into the core, can you
  actually read/gestalt it — do dots separate, are they distinguishable, does isolate/colour help? Only if reading
  *fails even with zoom+interaction, consistently across corpora* is there something to fix — and even then only in
  how it's *shown*, never the projection. **Do not touch discovery.**
- 🟡 `open` The cloud is a small blob in a sea of empty whitespace (uses ~⅓ of the canvas). Reads as unfinished.
- 🟢 `done` **Interaction core verified by live measurement** (`e2e/interaction.ts` — real drags read from live state):
  3D orbit rotates on drag (rotationOrbit 20°→48°); layouts switch; desktop hover fires; isolate→change-grain clears
  the stale pin cleanly. (Earlier I *claimed* orbit worked and got caught — now it's measured.)
- ⚪ `open` Still to judge, live + across datasets: the *smoothness/feel* of the layout "smoosh" (state switches, but
  does the motion read?), and whether you can actually read/gestalt the dense core by zooming in.

## J6 — use it on a phone
- 🟢 back-gesture closes overlays; 40px close targets; collapsed-by-default — done + verified. Re-judge the *feel*
  (pinch-zoom, one-handed reach, the reader scroll) live. ⚪ `open`

---

## Working order (worst-first, revisited every pass)
1. **Get diverse test data** — pull 3–4 varied markdown corpora (HF/GitHub) so every hypothesis is checked across
   datasets, not just Pathfinder/Readwise. Use `--embed raw` for fast layout/readability passes.
2. J5 interaction-feel study — verify the untested core *live*: orbit/transition/hover/combinations, and whether you
   can read the dense core by zooming. You can't judge a map you've never actually used.
3. J4 colour *reading* — facet isolate-on-click + a larger distinct palette. (Reading affordances only; never geometry.)
4. J1/J2 provenance — the file must introduce itself.
5. everything 🟡, then re-walk all journeys. Nothing here may change what gets discovered — only how it's shown/read.
