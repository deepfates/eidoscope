# Viewer parity spec — the acceptance contract for the cutover

Not pixel-for-pixel. The new Svelte + deck.gl viewer must carry **every feature, user story, and subtle
behavior** of the old `render.ts` viewer (and the things we said we wanted), in a cleaner professional
UI/UX, with **better performance**. This is the checklist the integration suite (`eid-55ln`) gates on;
nothing here may be silently dropped. `[ ]` = not yet ported, `[x]` = ported + verified in-browser.

## The user stories (the WHY — keep these felt, not just the controls present)
- [ ] "Open a folder of documents and see it as a little universe of its own" — the map reads as a place, not a chart.
- [ ] "Smoosh it around in different dimensions" — layout + encoding changes feel fluid and playful (animated transitions).
- [ ] The delight loop: **zoom into forgotten saved stuff → find a cool paper → tap the dot → it opens in my reader.** This exact path must feel good on a phone.
- [ ] Honest all the way down — nothing faked: variance shown, weak axes flagged, no invented structure. Position is a control, not a truth.
- [ ] Feels like a toy you can't put down, not a competent chart (craft ticket `eid-ywry`).

## Layout (position is a control)
- [x] **Neighbor map** (UMAP 2D) — default; proximity = similarity.
- [x] **Axis scatter** — position by ANY two discovered axes; pole labels on the four edges (← low / high →); the "~ minor axis" hint when a weak axis is chosen.
- [x] **3D orbit** — draggable rotation; depth cue (front points brighter/larger).
- [x] Smooth animated transition between layouts (the "smoosh").

## Color encoding
- [x] By **region** (emergent cluster) — the default.
- [x] By **folder** (source-folder metadata lens) — self-filtering: only offered if it covers most of the corpus with a legible number of values.
- [x] By **author** (metadata lens) — same self-filtering rule.
- [x] By **any discovered axis** — continuous low→high gradient.

## Size encoding
- [x] **Uniform**.
- [x] **Influence (hub)** — kNN in-degree; default.
- [x] **Commit to an axis** — |score − 50|, how strongly a card sits toward a pole.

## Grain (the nested clumps-all-the-way-down ladder)
- [x] **Grain slider** across the ladder (continents ↔ towns); region count + names update at each level.
- [x] **Drill-in**: click a region (legend) or double-click the map → fit camera to it + step grain finer so it resolves into sub-clumps (gentle step, not max).
- [x] Legend region **click = isolate + zoom** (sticky pin; click again releases + zooms out) — must NOT change grain (the bug we fixed).
- [x] Legend region **hover = transient isolate** (hull + dim others).
- [x] Grain change clears stale pins/highlights (cluster ids are grain-specific).

## Regions
- [x] **Convex-hull** highlight around an isolated region.
- [x] **On-map labels** at region centroids, collision-decluttered (deck TextLayer collision filter), **toggle on/off**.
- [x] **Legend**: region list with counts + colors + blurb on hover; header states the interaction ("click to isolate + zoom").
- [x] Colourblind-safe palette; identity carried by position + labels + isolate (colours cycle past ~8 — that's accepted, not a bug).

## Card interaction
- [x] **Tap/click a card → detail panel**: title, meta (author · date · region), **restatement** (core), **"where it sits"** = axis placements ranked by extremity with ▲/▼ + score, **nearest-N** neighbors (clickable → focus that card), **open source →** link (opens the reader).
- [ ] **Hover → tooltip** (desktop): title, core, hub, top axes. _(implemented + wired; deck.gl onHover doesn't fire under browser automation, so NOT machine-verified — needs a real-device check.)_
- [x] **Focus → neighbor spokes** drawn from the card to its nearest neighbors; dim non-neighbors.
- [x] Click empty space clears focus.
- [x] **Finger-sized picking** (pickingRadius) — tiny dots are still tappable.

## Deck / list view (the reader — and the accessibility surface)
- [x] Cards as a **sortable, filterable list** (real DOM).
- [x] **Sort by influence or any axis** (axis sort = a readable spectrum from one pole to the other).
- [x] **Text filter**.
- [x] **"Unread only"** toggle (when read-progress metadata is present). _(renders + same verified filter path; effect masked by the 300-card cap on this corpus.)_
- [x] Per-card: region chip, read chip, the 3 strongest axis chips, **open →** link.
- [x] Click a list card → focus it on the map + close the list.
- [x] **Keyboard-navigable + screen-reader labeled** — this view is the accessible parallel to the canvas.

## Frontier telescope (arxiv corpora, `--frontier`)
- [ ] **Ghost points** — cited-but-not-in-corpus papers placed near the work that cites them; sized by citation count.
- [ ] **Citation edges** toggle.
- [ ] Hover ghost → tooltip; click → arxiv.
- [ ] Clean no-op when the corpus has no arxiv ids (controls simply absent).

## Search & global
- [ ] **Find-a-card search** → dims non-matching points (and filters the list).
- [ ] **Theme** toggle (light/dark), full token-level theming.
- [ ] **Reset** — restores view + default grain + clears focus/pin.
- [ ] **Intro** modal — first-run explainer of the core interactions; remembered (localStorage).
- [ ] **Count readout** (N cards · layout · size).
- [x] **Axis hint** — contextual guidance text per layout.
- [x] **Weak/minor axis flagging** (~ prefix, `< 2%` variance) everywhere axes are listed; the report/intro states minor-axis count.

## Touch / mobile (must feel good — the reason for the rewrite)
- [ ] One-finger **pan** (rotate in orbit), two-finger **pinch-zoom** with inertia (deck controller).
- [ ] **Tap** opens a card; finger-sized targets.
- [ ] **Responsive layout** — panels to corners / detail as a bottom sheet; controls usable one-handed.

## Accessibility
- [ ] Keyboard operable end-to-end; ARIA on all controls (accessible dropdowns/slider/dialog).
- [ ] Focus management; visible focus states; `prefers-reduced-motion` honored.
- [ ] The list view is the map's accessible parallel (canvas can't be screen-read).

## Performance (the goal, not just parity)
- [ ] GPU rendering smooth at 15k (Pathfinder) and up to ~100k points.
- [ ] Binary data load (`.eido`, ~5× smaller than JSON) — fast parse, low memory.
- [ ] Measured same-or-better than the JSON build (`eid-huoe`).
