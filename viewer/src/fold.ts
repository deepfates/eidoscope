// PRIORITY COLLAPSE for the toolbar strip (eid-sh90 factoring; the mechanism is eid-ef7e / Hac-2hjp).
//
// The strip shows a whole control or none of it — never a control clipped mid-glyph. Each control
// declares a tier via `data-fold`; tier 0 never folds, and rising fold levels hide tier ≤ fold into the
// controls sheet, which is the SAME sheet the narrow layout opens.
//
// This came out of App.svelte because the arithmetic below is the part that has actually been wrong:
// shipped once as a pure estimate, it under-counted the real layout by 53px at 1900 and 94px at 1280, so
// the strip "fit" on paper while its middle group overflowed and "+ axis" drew on top of "open". Inside
// the component it could not be unit-tested at all. Now the estimate is arithmetic with a test, and the
// DOM half is a thin watcher around it.

export type FoldBox = { tier: number; width: number };

/** The starting guess: the smallest fold level at which the declared item widths fit the available room.
 *
 *  A LOWER BOUND ON PURPOSE. It adds up item boxes and cannot know what the flex layout really spends on
 *  paddings, dividers and the groups' own gaps, so `foldWatch` settles the remainder against real
 *  scrollWidth. Returning a guess that is too SMALL is the safe direction — the settle loop only ever
 *  folds further, so an over-eager estimate would hide controls that fit and never give them back. */
export function foldEstimate(a: { avail: number; fixed: number; trigger: number; boxes: FoldBox[]; max: number; gap: number }): number {
  const { avail, fixed, trigger, boxes, max, gap } = a;
  for (let f = 0; f < max; f++) {
    // tier 0 is unfoldable and always counted; a tier above the current level is still on screen
    let need = fixed + (f > 0 ? trigger : 0);
    for (const b of boxes) if (b.tier === 0 || b.tier > f) need += b.width + gap;
    if (need <= avail) return f;
  }
  return max;
}

/** True when any direct child of the row is overflowing its own box — the thing the estimate cannot see. */
export const rowOverflows = (row: HTMLElement): boolean =>
  [...row.children].some((c) => c.scrollWidth > c.clientWidth + 1);

/** Read the row and hand back a fold level. `settle` yields a frame so the caller's re-render lands
 *  before the next overflow read; `token` lets an older run bow out when a newer one has started. */
export async function measureFold(row: HTMLElement, o: {
  max: number; gap?: number; slack?: number;
  set: (f: number) => void; settle: () => Promise<void>; stale: () => boolean;
}): Promise<void> {
  const gap = o.gap ?? 4, slack = o.slack ?? 40;   // the strip's gap-1, plus paddings/dividers not itemized
  const els = [...row.querySelectorAll<HTMLElement>("[data-fold]")];
  if (!els.length) return;
  let fixed = slack;
  for (const el of row.querySelectorAll<HTMLElement>("[data-fold-fixed]")) fixed += el.getBoundingClientRect().width + gap;
  const trigger = (row.querySelector<HTMLElement>("[data-fold-trigger]")?.getBoundingClientRect().width ?? 0) + gap;
  const boxes: FoldBox[] = els.map((el) => ({ tier: +(el.dataset.fold || 0), width: el.getBoundingClientRect().width }));
  let f = foldEstimate({ avail: row.clientWidth, fixed, trigger, boxes, max: o.max, gap });
  o.set(f);
  // …AND THEN THE PIXELS DECIDE. Fold one more tier at a time until nothing overflows for real.
  while (f < o.max) {
    await o.settle();
    if (o.stale()) return;                 // a newer measurement owns the level now
    if (!rowOverflows(row)) break;
    o.set(++f);
  }
}

/** The Svelte action: re-measure on resize and on content changes.
 *  childList + characterData only — NOT attributes, because our own class flips are attribute changes and
 *  would re-trigger this forever. */
export function foldWatch(node: HTMLElement, run: () => void): { destroy(): void } {
  const ro = new ResizeObserver(run); ro.observe(node);
  const mo = new MutationObserver(run); mo.observe(node, { childList: true, subtree: true, characterData: true });
  run();
  return { destroy() { ro.disconnect(); mo.disconnect(); } };
}
