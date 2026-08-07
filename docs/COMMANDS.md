# The eidoscope command table

Coherence means the viewer is **one command system**, not a pile of controls. Each row below is a
*semantic command* — a verb acting on an object at a stated scope, producing a visible result. Every
surface (toolbar menu, legend row, map gesture, keyboard, URL, the `__eido` test seam, and one day an
agent) is only a **binding** to one of these commands. Two bindings to the same command must do the
same thing and be called the same thing.

Everything here was read out of the source and then **driven in real Chromium** on `map.eido`
(1446 Readwise docs, v2 file) and `tldr.eido` (6261 CLI pages, v1 file) — see the verification log at
the end.

Notation: **scope** is what the command acts on — `view` (the whole viewer), `channel` (one visual
slot), `dimension` (one per-card field), `corpus` (the filter set), `card`, `camera`, `chrome`.

---

## 1. The table

| # | Command | Verb · object · scope | Binding(s) today | Parameters | Visible result | URL | Kbd | Undo / reset |
|---|---|---|---|---|---|---|---|---|
| **Framing — what the map is** |
| 1 | `about.show` | *inspect* provenance · view | corpus name in the toolbar (desktop + phone) | — | popover: how positions/axes/regions were derived, variance explained, weak-axis count, card model, embedder, geometry basis, source, date | n | Tab→Enter | Escape |
| 2 | `intro.dismiss` | *dismiss* the welcome · view | "explore →" button | — | intro closes; remembered in `localStorage` | n | Tab→Enter, Escape | reappears for a newly opened file |
| 3 | `corpus.open` | *load* a corpus · view | drop a `.eido` on the window | file | whole viewer remounts on the new corpus, intro shown | via `?map=` / `?url=` | n | reload |
| **Layout — where cards are placed** |
| 4 | `layout.set` | *set* layout · view | `layout ▾` menu (4 items: neighbor map · axis scatter · **3D neighbor map** · 3D axis scatter) | `mde \| axes \| orbit \| axes3d` | points re-lay-out; the button states the current layout | `?layout=` | Tab→Enter | `layout → neighbor map` |
| 5 | `overlay.toggle` | *toggle* an overlay · view | `layout ▾` menu (cite edges, frontier) | — | citation edges / ghost papers drawn | **n** | Tab→Enter | same item |
| 6 | `axis.set` | *put* a dimension on x/y/z · channel | `axes ▾` popover selects (scatter layouts only) | dimension key | points move; pole labels at the map edges change | `?x= ?y= ?z=` | Tab→select | pick another |
| 7 | `dim.norm` | *set* honest⇄rank · dimension | `axes ▾` buttons; the "scale" section of the color / size / time popovers | `honest \| rank` | the dimension's spread changes **everywhere it is placed at once** | `?props=k.h0` | Tab→Enter | the other value |
| 8 | `dim.invert` | *flip* direction · dimension | same four places | — | high↔low swap, pole labels swap with them | `?props=k.h1` | Tab→Enter | same button |
| **Encoding — what cards look like** |
| 9 | `color.set` | *put* a dimension on colour · channel | `color ▾` popover, "color by" list; the ● button on a query chip | dimension key or `region` | every point recolours; the legend above becomes that dimension's legend | `?color=` | Tab→Enter | `color → region` |
| 10 | `size.set` | *put* a dimension on size · channel | `size ▾` popover | dimension key or `uniform` | point radii change | `?size=` | Tab→Enter | `size → uniform` |
| 11 | `grain.set` | *set* clustering grain · view | **toolbar slider** (always visible; a parameter of the region dimension, not of any channel) | 0…nLevels-1 | regions merge/split; the count next to the slider and in the toolbar updates | `?grain=` | Tab→arrows | `reset view` |
| 12 | `labels.toggle` | *toggle* region labels · chrome | `region labels` button (disabled off the region lens, with a tooltip saying why) | — | region names appear/disappear on the map | **n** | Tab→Enter | same button |
| **Selecting — narrowing the corpus** |
| 13 | `region.isolate` | *isolate* one region · corpus | click a legend row under colour = region (the row shows `isolate` / `release` on hover or focus) | cluster id | non-members hidden, camera flies to the set, chip appears, `N / M cards` updates, region detail pane opens | `?region=` | Tab→Enter | click again · chip ✕ · `reset view` |
| 14 | `facet.isolate` | *isolate* one categorical value · corpus | click a legend row under a categorical colour lens (same visible `isolate` cue) | value | same as above, for that value | `?facet=` | Tab→Enter | click again · chip ✕ · `reset view` |
| 15 | `find.set` | *filter* by substring · corpus | the `⌕ find a card…` input | text | non-matching cards hidden, chip `"…"`, `N / M cards` updates | `?find=` | type | empty the box · chip ✕ · `reset view` |
| 16 | `scrub.field` | *choose* which dimension the window applies to · channel | select inside the `window ▾` popover | dimension key | the slider re-ranges; any existing window is cleared | `?sk=` | Tab→select | pick another |
| 17 | `scrub.window` | *window* a scalar/temporal range · corpus | dual-thumb slider in `window <dim> ▾` | lo, hi | out-of-range cards hidden, chip `<dim> window` | `?slo= ?shi=` | Tab→arrows | `clear` · chip ✕ · `reset view` |
| 18 | `filter.remove` | *remove* one filter · corpus | click a chip | the filter | that constraint lifts | (its param drops) | Tab→Enter | re-apply |
| 19 | `filter.clearAll` | *remove* every filter · corpus | `clear all filters` (only shown with ≥2 chips) | — | all constraints lift | (params drop) | Tab→Enter | — |
| **Interrogating — asking the corpus a question** |
| 20 | `query.add` | *create* a semantic dimension · view | `+ axis ▾` popover → `add` / Enter | text | a new dimension appears in **every** channel menu; badge count increments. **Nothing on the map moves** (see M-D1) | `?q=` (repeatable) | type + Enter | the ✕ on the query chip |
| 21 | `query.remove` | *delete* a semantic dimension · view | ✕ on the axis chip | key | every channel holding it falls back to its default | (param drops) | Tab→Enter | re-add |
| **Holding — a frozen set of cards (SELECT / DERIVE)** |
| 22 | `select.mode` | *arm* the lasso · view | `select` toolbar button (desktop + phone controls sheet) | — | button lights, hint "drag to circle cards · Escape to leave"; map drag now draws instead of panning. **Nothing else changes** | n | **s** · Escape leaves | same button · Escape · `reset view` |
| 23 | `select.lasso` | *hold* a circled set · view | drag a closed path in select mode (one-finger on phone; pinch still zooms) | path | selection pane docks right: count, % of corpus, distinctive terms, distinctive axes, members, and the verbs below. A straight line has no area and holds nothing | `?sel=` (card ids, ≤200 — beyond that the pane says the link can't carry it) | — | `clear` · ✕ · Escape · `reset view` |
| 24 | `select.filter` | *filter* to the held set · corpus | `filter to these` in the selection pane | — | everything else hidden; chip `selection (N)`; the selection is **consumed** by the filter (one state, not two); composes by AND with other filters | (chip drops `sel=`) | Tab→Enter | chip ✕ · `reset view` |
| 25 | `select.fit` | *frame* the held set · camera | `fit` in the selection pane | — | camera eases to the set's bounds (depth-aware in 3D). Explicit — holding a set never moves the camera by itself | n | Tab→Enter | `reset view` |
| 26 | `select.export` | *download* the held set · view | `export` in the selection pane | — | JSON file of ids, titles, urls | n | Tab→Enter | — |
| 27 | `select.clear` | *release* the held set · view | `clear` in the selection pane; ✕ closes the pane | — | selection released; map de-emphasis lifts | (`sel=` drops) | Tab→Enter | re-circle |
| 28 | `derive.mint` | *mint* a dimension from the held set · view | `derive axis` in the selection pane, then name it | name (defaults to the top distinctive term) | a `≈ name` dimension scoring every card by likeness to the set appears in **every** channel menu, with `place on colour / size / x` shortcuts in the pane. **Nothing on the map moves** until you place it | `?d=name~ids` (≤200 example ids; beyond that the pane says the axis won't come back on reload) | Tab→Enter | `remove this axis` |
| 29 | `derive.rename` | *rename* a derived dimension · dimension | the name field in the pane | text | the label updates everywhere the dimension is placed | `?d=` label part | type | — |
| 30 | `derive.remove` | *delete* a derived dimension · view | `remove this axis` in the pane | key | every channel holding it falls back to its default | (`d=` drops) | Tab→Enter | re-derive |
| **Reading — the cards themselves** |
| 31 | `card.open` | *open* one card · card | click a point; click a deck row; click a neighbour in the detail pane | index | detail pane docks right (bottom sheet on phones): restatement, axis placements, neighbours, source links | `?card=` | via the deck | ✕ · Escape · Back |
| 32 | `card.hover` | *preview* one card · card | hover a point | — | tooltip: region, title, first ~140 chars | n | **n** | move away |
| 33 | `region.drill` | *descend* into a region · view | **double-click a point** | index | grain steps finer (≤3 levels) until the region splits; camera fits the sub-region | (via `?grain=`) | **n** | `reset view` |
| 34 | `deck.open` | *list* the corpus · view | `deck` button (desktop + phone) | — | modal list of every card — the screen-reader-accessible view of the map | **n** | Tab→Enter | ✕ · Escape · Back |
| 35 | `deck.sort` | *sort* the list · channel | select inside the deck | dimension key | rows reorder | **n** | Tab→select | pick another |
| 36 | `deck.filter` | *filter* the list · **deck only** | `find in list…` input inside the deck | text | rows narrow. **Does not touch the map or the chips** (see M-N2) | **n** | type | empty the box |
| 37 | `deck.unread` | *filter* to unread · **deck only** | `unread only` toggle (only when the corpus carries read state) | — | read rows hidden | **n** | Tab→Enter | same button |
| 38 | `source.open` | *open* the original · card | links in the detail pane and on deck rows | — | new tab | n | Tab→Enter | — |
| **Camera** |
| 39 | `camera.pan` | *move* the camera · camera | drag | — | view translates | n | **n** | `reset view` |
| 40 | `camera.zoom` | *scale* the camera · camera | wheel / pinch | — | zoom; more region labels reveal as you go in | n | **n** | `reset view` |
| 41 | `camera.rotate` | *orbit* the camera · camera | drag in a 3D layout | — | view rotates | n | **n** | `reset view` |
| 42 | `camera.fit` | *frame* a set · camera | implicit in `region.isolate` / `facet.isolate` / `region.drill` | indices | camera transitions to the set | n | — | `reset view` |
| **Chrome** |
| 43 | `theme.flipGround` | *flip* light⇄dark · chrome | `☾ / ☀` button | — | whole app **and the map canvas** re-ink from the theme's tokens | `?theme=` | Tab→Enter | same button |
| 44 | `theme.set` | *set* the theme · chrome | theme `▾` menu (10 themes, each with a swatch) | theme id | as above | `?theme=` | Tab→Enter | pick another |
| 45 | `controls.sheet` | *reveal* the controls · chrome | `controls ▴` (phone only — renders the identical `controls()` snippet) | — | bottom sheet with every toolbar command | n | Tab→Enter | Escape · Back |
| 46 | `view.reset` | *reset* filters + selection + grain + camera · view | `reset view` button | — | every chip clears, card closes, grain returns to the file's default, camera goes home | (params drop) | Tab→Enter | — |
| 47 | `overlay.close` | *close* the topmost overlay · view | ✕ buttons; **Escape**; browser **Back** | — | intro / deck / sheet / card closes | n | **Escape** | re-open |

### Bindings that are not user commands

`?map=` and `?url=` pick which `.eido` to load (`loader.ts`, sandboxed to a bare same-origin filename
or an `http(s)` URL). `window.__eido()`, `__eidoProject()`, `__eidoPick()` are the read-only
integration seam — they observe state, they never set it. `Tab` is focus movement; it is trapped
inside the deck / sheet / intro modals and deliberately **not** trapped by the card pane, which is
docked rather than modal so the toolbar stays operable while you read.

---

## 2. Mismatch list

### M-A · One binding where a second is cheap

- **M-A1 `region.drill` is double-click and nothing else.** It is one of the four things the intro
  teaches, it has no keyboard route, no menu item, and no direct URL form (only the `?grain=` it
  happens to move). Cheap second binding: a "drill in" item in the region detail pane, which is
  already open and already knows the region.
- ~~**M-A2 `grain.set` is reachable only from inside the colour popover, and only while colour = region.**~~ **FIXED 2026-08-06** — grain is a first-class toolbar control at every lens.
  Grain still governs the regions the hover tooltip names, the region filter, and the drill target
  under *every* lens — but the moment you colour by anything else, the control vanishes. The state is
  still shown ("21 regions" in the toolbar), so the user can see a thing they can no longer touch.
- **M-A3 `labels.toggle`, `deck.open`, `view.reset` have no expert route.** Every critical command is
  supposed to get a discoverable route *and* an expert one; these have only the button.
- **M-A4 `facet.isolate` can only isolate on the dimension currently on the colour channel.** You
  cannot isolate by folder while colouring by influence. The model even drops your facet filter
  silently when you switch lens (`dropStaleFacets`). Isolate is a *corpus* command tied to a *channel*.
- **M-A5 `camera.*` has no keyboard route at all.** Pan/zoom/rotate are pointer-only; there is no
  keyboard path to move the camera, which makes the whole map keyboard-inoperable except through the
  deck.

### M-B · The URL claims to mirror the view, and doesn't

`serializeUrl` is documented as "the URL always mirrors the current view". Five commands are missing
from it, so a shared link silently loses them:

- **M-B1** `overlay.toggle` — cite edges and frontier ghosts do not survive a share or a reload.
- **M-B2** `labels.toggle` — same.
- **M-B3** `deck.sort` — the `sort` channel is a first-class channel in `CHANNELS` and is the only one
  of the seven that is never serialized.
- **M-B4** `deck.filter` / `deck.unread` — a second, invisible filter set (see M-N2).
- **M-B5** the deck being *open* is pushed to history (so Back closes it) but not to the URL, so a
  link never opens on the list view.

### M-C · Scope is not shown

The ticket's rule is: always expose the current scope, never say "these".

- **M-C1 `N / M cards` only exists while a filter is active.** The chips row is collapsed to zero
  height otherwise, so the corpus size lives only in the toolbar subtitle and the two never appear
  together.
- **M-C2 No chip carries its own count.** With three chips you see the size of the intersection and
  nothing else — you cannot tell which constraint is doing the cutting. `region "Agent-Native
  Engineering" · 813` would be the whole fix.
- **M-C3 The scrubber chip says `<dim> window` and not the window.** The range you actually chose is
  only visible inside the popover you just closed.
- **M-C4 `deck.filter` / `deck.unread` narrow the list with no chip anywhere**, and the deck's own
  `N cards` is the only readout.

### M-D · The result is invisible

- **M-D1 `query.add` is the sharpest case.** You type a question, press ⌕, wait through a 23MB model
  download — and the map does not change. The dimension was created but placed on no channel (a
  deliberate decision: "making an axis and placing it are separate acts"). The only feedback is a
  badge counter. The decision is right; the *feedback* is missing — it should say what was made and
  offer the placement, e.g. "semantic axis added — put it on colour / size / x".
- **M-D2 `dropStaleFacets` deletes a filter with no explanation.** Switching the colour lens makes an
  active facet chip vanish. The user did not remove it and is not told why it went.
- **M-D3 `deck.sort` has no effect until the deck is open**, and there is no sort control outside the
  deck — so setting a channel from one surface produces a result only visible on another.
- **M-D4 (fixed)** The `labels.toggle` command had no observable result through the `__eido` seam at
  all: the seam reported the number of label *candidates*, which does not move when you toggle
  labels. Found by asserting on it and watching `5 → 5`. Fixed by adding `labelsOn`.
- **M-D5 (fixed)** Every channel-setting option signalled its current value with a `✓` glyph and
  nothing machine-readable. Fixed with `role=menuitemradio`/`aria-checked` and `aria-pressed`.
- **M-D6 (fixed)** The three `honest / rank / invert` buttons in the axes popover had no accessible
  name whatsoever, while the *same command* in the colour/size/time popovers did. Fixed; all four
  sites now name the dimension they act on.

### M-E · Fixed in this pass

Mechanical only — behaviour unchanged. See commits `6879c70`, `c703ec6`, `83d3835`.

- The viewer hardcoded its meta-dimension list while the pipeline was emitting a typed `D.metaFields`
  manifest that nothing read. Now consumed, with a legacy fallback for v1 files.
- The dead `source: "region"` branch in `dimensions.ts` — deleted (rationale in §4).
- Missing `aria-checked` / `aria-pressed` on every channel option and property toggle.
- Missing tooltips on `reset` (whose scope was stated nowhere), `deck`, `cite edges`, `frontier`,
  `unread only`, and every colour/size option.
- Filter chips said "remove filter"; they now name the filter.
- `labelsOn` added to the `__eido` seam.

---

## 3. Naming proposal — **APPLIED 2026-08-06**

Every ruling below was accepted and is now in the code (branch `agent/naming`). Each row is
*current → proposed → why*; "current" is the pre-ruling name, kept as the record of what changed.
The rulings are labels only — no URL parameter, no wire field and no state key moved.

**As applied**, exactly:

| Was | Is now |
|---|---|
| toolbar `time <lo> – <hi>` | `window <dimension> <lo> – <hi>` — the windowed dimension is always named, so "time" appears only when the dimension *is* the date |
| `+ query` button · `semantic axis` popover title · `⌕` submit · `⌕ <text>` dimension name | `+ axis` button · `axis from a question` popover title · `add` submit · `? <text>` dimension name (the find box keeps `⌕`, now its only meaning) |
| deck `filter…` | deck `find in list…` (toolbar stays `find`) |
| author dimension `source` · provenance `from <path>` | `author` · `corpus source <path>` |
| layout `3D space` | `3D neighbor map` |
| `labels` toggle | `region labels` |
| scrubber `clear window` · chips `clear all` · toolbar `reset` | `clear` · `clear all filters` · `reset view` |
| legend row: isolate visible only to a screen reader | the row shows `isolate` (or `release`, when active) on hover / focus |
| pipeline manifest labels `author / source`, `tags` | `author`, `tag` — and `NAME_OVERRIDE` in `viewer/src/dimensions.ts` is **gone**, so a file's own manifest labels now flow straight through. One two-entry migration remains, keyed on the retired label *strings*, so `.eido` files written before the rulings don't display a name we retired. |

**Kept, explicitly:** `grain`, `deck`, the `region` overload (§N-3), `tag` singular, `frontier` in the
UI over `ghosts` in the code.

### N-1 · One concept, several names

| Current | Proposed | Why |
|---|---|---|
| toolbar button **`time`** | **`window`** | The single worst mislabel in the app. This control windows *any* scalar or temporal dimension — on `map.eido` it offers **19 dimensions, 18 of which are not time** (16 PCA axes, influence, length). A user windowing "length" is clicking a button labelled "time". The popover's own inner label is already `window`. Caught in the wild: on `tldr.eido` the toolbar reads **`time 0 – 100`**, because the scrubber parked on a unitless PCA axis (verified live on tldr.eido; fixed in cc236f5). |
| **`+ query`** (button) · **`semantic axis`** (popover title) · **`⌕`** (submit) · **`⌕ <text>`** (the dimension's name in menus) | **`+ axis`** everywhere, dimension shown as **`? <text>`** | Four names for one concept, and `⌕` is *also* the find box's glyph — the same symbol means "substring search" in one place and "embed a semantic query" in another. |
| **`find`** (toolbar, filters the map) vs **`filter…`** (deck, filters only the list) | **`find`** for both, with the deck's scoped as **`find in list`** | Same verb, same input type, same substring semantics, two names — and the difference that actually matters (map-wide vs list-only) is the one thing neither name states. |
| **`source`** = the *author* dimension · **`source site`** = siteNames · **`from <source>`** = provenance path · **`original →`** = the document's own URL | author dimension → **`author`**; provenance → **`corpus source`** | "Source" currently means four different things on screen. The pipeline's own manifest calls this field `author / source`; the viewer shows `source`. Settling this row un-pinned `NAME_OVERRIDE` in `dimensions.ts`, which had been holding the viewer's own names in front of the manifest's; the manifest is now the single source of a dimension's name. |
| **`frontier`** (menu item) vs **`ghosts`** (the code, the layer, the option key) | **`frontier`** in the UI, keep `ghosts` internal | Only a mismatch for whoever reads both; the hover tooltip already says "frontier paper". Listed for completeness. |
| **`tag`** (viewer) vs **`tags`** (manifest label) | **`tag`** | Singular reads correctly in "colour by tag". One-word fix; only needs a ruling because it means dropping the manifest's label. |
| **`honest magnitudes` / `rank-normalized`** (menus) vs **`honest` / `rank`** (axes popover) | long form in menus, short in the compact button row, but **always in that order** | Same command, two vocabularies. Acceptable if it's a deliberate long/short pair; currently it reads as two different features. |

### N-2 · Names that describe the mechanism, not the act

| Current | Proposed | Why |
|---|---|---|
| clicking a legend row (no visible verb; `aria-label` says **`isolate`**, the model calls it **`pin`** / **`facetPin`**, the URL calls it **`region`** / **`facet`**) | **`isolate`** everywhere, and say it visibly | One command, four names, and the *only* place the user can read the verb is a screen-reader label. The legend row should carry a visible "isolate" affordance on hover/focus. |
| **`grain`** | **`grain`** (keep) | It is a real word for a real thing and the intro teaches it ("continents to towns"). Keeping it, noted so the ruling is explicit. |
| **`3D space`** (layout) | **`3D neighbor map`** | The other three layouts name their geometry — `neighbor map`, `axis scatter`, `3D axis scatter`. `3D space` is the orbit view *of the neighbor map*, so the one name that breaks the parallel is the one that hides the relationship. |
| **`deck`** | **`deck`** (keep) | Load-bearing project vocabulary (`deck.jsonl`, `cardCorpus`), and the modal's aria-label already says "deck reader". |
| **`labels`** | **`region labels`** | It only ever labels regions, and it is disabled off the region lens — the button's name should say what it labels. |
| **`clear window`** (scrubber) · **`clear all`** (chips) · **`reset`** (toolbar) | **`clear`** at the local scope, **`clear all filters`** at the chip row, **`reset view`** at the toolbar | Three verbs for three nested scopes is right; three *different* verbs for them is not. Making the scope explicit in each label makes the nesting legible. |

### N-3 · The word "region"

`region` currently names: the colour-channel sentinel (`color: "region"`), a `Filter` kind, the
cluster concept itself, the isolate command's URL param, and the `regions` count in the toolbar. That
is coherent — they *are* all the same object — and the proposal is to **keep it**, recorded here only
so the overload is a decision rather than an accident. It is also the reason the `region` *dimension*
was deleted rather than wired (§4).

---

## 4. The region-as-dimension decision: **deleted**

`dimensions.ts` carried a `source: "region"` variant of `DimSource` and a matching branch in
`colorAccessor`. Both were dead — nothing ever constructed such a dimension. The choice was to wire it
properly or remove it. **Removed**, because wiring it costs special-casing everywhere and buys nothing:

1. **It isn't a per-card column.** Every other dimension reads a stored array. A region assignment is
   *derived from the current grain*, so a region dimension would have to be rebuilt on every grain
   change and could never be memoised like the others — it would be the one dimension in the registry
   that is not a pure function of the file.
2. **Its key collides three ways.** `"region"` is already the colour-channel sentinel, already a
   `Filter` kind, and already a URL param. A dimension keyed `region` would shadow the sentinel in
   `colorDim`, and `Filter{kind:"cat", key:"region"}` and `Filter{kind:"region"}` would both exist
   and mean the same thing — two filter records for one constraint.
3. **The menu entry would duplicate.** The colour menu's "region" option would have to be suppressed
   from the categorical list to avoid appearing twice.
4. **The sentinel path is already one branch.** `colorDim` resolves to `undefined` for `"region"`, and
   `colorAccessor`'s existing `if (!dim)` fallback colours by the assignment. That is strictly less
   machinery than a synthetic dimension plus three collision guards.

Deleting removed the dead branch *and* the `DimSource` variant, and `colorAccessor`'s categorical case
collapsed from three branches to one. The trade-off accepted: region cannot be placed on size, x/y/z,
or the scrubber — which is correct, since a cluster id is a nominal label with no magnitude and no
order, and putting it on a scalar channel would be meaningless.

---

## 5. Verification

Driven in real Chromium (Playwright, 1440×900) against the built single-file viewer, every command in
§1 exercised at least once on `map.eido`, plus the v1 fallback path on `tldr.eido`.

Selected results:

```
── map.eido (v2, 1446 cards, 21 regions) ──
  ✓ first-run intro introduces the corpus / dismissed by its explore button
  ✓ about popover opens and explains positions/axes/regions
  ✓ about shows derivedBy: card model, embedder, geometryBasis
  ✓ about shows axis count + variance sum
  ✓ layout → axes / orbit / axes3d / mde
  ✓ color → `read` (a categorical that ONLY the metaFields manifest supplies)
  ✓ color → influence (scalar) / region (sentinel)
  ✓ size → uniform serializes to ?size=
  ✓ grain → level 2 (9 regions)
  ✓ isolate region — 1446 → 813 visible, chip="Agent-Native Engineering and GRPO Benchmarks"
  ✓ isolate region serializes to ?region= / re-click releases it
  ✓ find "agent" — 552 match, chip=“agent”, serializes to ?find=
  ✓ scrubber offers 19 scalar/temporal dims
  ✓ click a point opens the card detail pane, serializes to ?card=, Escape closes it
  ✓ deck opens / filter narrows / sort switches / Escape closes
  ✓ labels toggle turns region labels OFF (observable via the new labelsOn seam)
  ✓ labels button reports its state via aria-pressed
  ✓ ☾/☀ flips the ground — light → dark;  theme picker → nord
  ✓ double-click drill
  ✓ reset clears filters + selection + camera
  ✓ URL restores layout+color+size+grain
  ✓ facet-isolate on a MANIFEST-derived categorical — facetPin="not read", 1446 → 1012

── tldr.eido (v1, no metaFields manifest → LEGACY_FIELDS fallback) ──
  ✓ tldr loads — 6261 cards, 21 regions
  ✓ about degrades honestly on a pre-v2 file: "provenance not recorded (pre-v2 file)"
  ✓ about still names the corpus + its source on a v1 file
  ✓ tldr fallback yields the legacy scalar set (influence, length + the 16 discovered axes)
  ✓ no console/page errors during the run
```

Verification evidence (screenshots were taken and reviewed at the time; they are not committed —
the repo tracks source, not artifacts, and `git show 9fa904b` still has them if needed):
the About popover on `map.eido`; isolate on `read`, the manifest-only categorical — chip, camera fit
and `1012 / 1446 cards` all visible; `tldr.eido` region isolate,
`244 / 6261 cards`).

**A note on `tldr.eido` and folders.** It was expected to exercise folder facets. It does not, and
cannot: `folder` is derived from a `file://` URL, and every `tldr` document carries an `https://`
upstream URL instead — so the folder dimension has always been empty on that corpus, before and after
this change. The manifest-derived categorical was therefore verified on `map.eido`'s `read` field
(`read` / `not read`), which the old hardcoded list could not offer at all, and on `pathfinder.eido`,
whose `folder` and `tags` now come from its manifest rather than from a guess. Old and new
`buildDimensions` were diffed across all three corpora: identical dimension keys everywhere, plus the
one genuinely new manifest-only dimension.

---

## Amendments — 2026-08-06 (evening)

- **`region.isolate` / `facet.isolate` no longer move the camera.** They are filters; the interaction
  law (*one action changes one thing*) forbids an incidental camera flight, and it made every
  `?region=` deep link re-frame the view the sharer had chosen. The camera moves only on explicit
  request: the new **`view.fit`** command (the `fit` button in the selection and region panes), or
  `view.reset`.
- **New command — `view.fit`** · *frame* a set · view. Binding: `fit` button in the reading pane
  (selection or isolated region). Result: camera eases to the set's bounds (depth-aware in 3D).
  Not serialized (camera never has been). Undo: `reset view`.
- **`card.open` uses an overlay pane.** The reading pane no longer resizes the map — it overlays the
  right edge — so opening a card cannot shift the layout under a click.
