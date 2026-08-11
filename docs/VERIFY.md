# How we know it works

Three instruments, each answering a different question. None of them substitutes for another, and
none of them is the judge of taste — that is deepfates', at the end.

## 1. `bun run qa` — is it correct?

Types, svelte-check, unit tests, the viewer build, and the browser end-to-end suites (viewer, ingest,
HuggingFace, OPFS cache, descend, kNN, durability, offline). Everything here is deterministic and
hermetic: the LLM is mocked at the network edge, the embedder is served from local `node_modules`,
nothing touches the real network.

**Run the whole thing, not a subset.** A green subset once hid a red gate on `main` for two hours
(`eid-0jeu`): the concurrency change broke an OPFS test whose design had quietly encoded the old,
slower carding speed. If the whole gate is too slow to run every time, that is a bug in the gate.

## 2. `bun run smoke:real` — does it work against reality?

One small corpus, the real provider, a real key, real calls. It exists because a fully green mocked
suite once sat on top of an app whose carding was 100% broken in the browser — the mock answered
where the real provider refused a header. Mocks prove the shape of a thing; only reality proves the
thing.

## 3. Walking the loop — does it work *for a person*?

`qa` cannot see a 546ms pause, a click that loses your place, or a two-second operation with no sign
it is running. So we walk the v1 loop on a **real corpus** — notice → hold → derive → see → notice —
timing each step the way a person would feel it, and screenshotting what a person would see. The
scripted walk lives in the scratchpad, not in `qa`: it is a **field report, not a gate**. Its output
is findings with numbers attached, and those findings are what the polish tickets are made of.

Rules that keep it honest:

- **Suspect the instrument before the code.** Playwright's `waitForFunction` polls on animation
  frames, so while the map runs its 700ms position transition the poll cannot land: it reports when
  the view SETTLED, not when the app RESPONDED. The same event measured 650ms polled and 70ms
  stamped from inside the page. Every timing in the walk is now stamped by in-page listeners.
- **The walk measures the FIRST of everything.** When a fix does not move a number, ask whether it
  moved the cold case or the warm one — the tf-idf index fix looked inert for hours because the walk
  only ever measured the one lasso that pays for building it.
- **Optional actions get optional timeouts.** Sixteen `.click().catch(() => {})` calls on a button
  that no longer appears each waited out Playwright's 30-second default and swallowed the failure —
  87% of the gate's runtime, invisible.
- **Unminified builds name the slow function.** `npx vite build --minify false`, served locally with
  the real `.eido`, turns long-animation-frame attribution from `ar:545ms` into `lassoUp:576ms`.
- **Walk the deployed artifact**, in the state a visitor actually lands in. Tickets have been closed
  from reading code and were wrong (`eid-9rdy`: folder ingest was unreachable on the live site while
  its tests passed, because the tests started from a state no visitor ever sees).
- **Every fix gets re-walked.** A fix that does not change what a stranger experiences is not a fix;
  the number it was filed with is the number that has to move.
- **Hidden is not gone.** A check for overlapping toolbar controls reported collisions at every width.
  False alarm: folded controls are `invisible absolute`, so they stay in the layout stacked at one spot.
  Anything that reads geometry has to ask what is genuinely visible, not merely what is in the tree.
- **Never budget a guaranteed action like an optional one.** The mobile case opens a fresh browser
  context, so it always meets the introduction — but it dismissed it with the same optional 1200ms click
  used where the intro may not appear. The intro cannot render until the map has mounted, which blocks
  the main thread: 29ms on one run, 1206ms on the next, straddling the budget. When it lost, the modal
  stayed up and ate the next click. Wait for the thing itself; optional timeouts are only for genuinely
  optional things.
- **A screenshot is a test.** Three live bugs came from looking at a picture, not from an assertion:
  region labels floating over a map filtered down to nothing, a status message drawn on top of the
  controls beside it, and two region names drawn through each other at 375px. All passed every check we
  had. So photograph the states nobody has looked at — each layout, both 3D views, the dark themes, the
  deck, mobile — and actually look.
- **When something draws to a canvas, expose where it put things.** A TextLayer leaves nothing in the
  DOM, so "do two labels overlap?" was unanswerable until `labelBoxes()` returned the renderer's own
  placement. Then size the boxes with the real glyph metrics of the font it draws in, not with the
  layout code's own approximation — otherwise the test agrees with the bug.
- **Measure the expensive path, not the cheap one.** A lasso timing that only measured
  `pointInPolygon` on random points said "fast" while skipping the projection work the real path
  pays. Falsify by measuring the thing that would hurt.

## What we do not do

- No metric that, maximised, defeats the tool. The concept bottleneck is the point: the map is built
  from the readable cards, never routed around them to buy a better number.
- No speculative optimisation. Two "scale swaps" were dropped after measurement showed nobody waits
  on them (`eid-cl83`: lasso is 3ms at 19k and 40ms at a million; the grain ladder is 44s at 100k).
- No claim without a receipt. If a number appears in a ticket or a commit message, it was measured,
  and where it came from is written next to it.
