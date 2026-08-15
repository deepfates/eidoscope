// SVELTE ACTIONS — focus behaviour that is pure DOM (eid-sh90 factoring).
//
// These lived in App.svelte, where they touched none of its state and could not be tested without
// mounting the whole component. They are the accessibility contract for every overlay in the app, so
// "untestable and 1,700 lines from the top of the file" was the wrong place for them.

type Action = { destroy(): void };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants that are actually rendered (offsetParent is null for display:none subtrees). */
export const focusables = (node: HTMLElement): HTMLElement[] =>
  [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null);

/** Where Tab should land, given the ring, who has focus, and whether Shift is down.
 *  Returns null when the browser's own default is correct — the whole point of a trap is that it
 *  intervenes at exactly two places (the ends) and nowhere else. */
export function tabTarget(ring: HTMLElement[], active: Element | null, shift: boolean, inside: boolean): HTMLElement | null {
  if (!ring.length) return null;
  const first = ring[0], last = ring[ring.length - 1];
  if (shift && (active === first || !inside)) return last;
  if (!shift && active === last) return first;
  return null;
}

/** MODAL: focus enters on mount, Tab cycles inside, focus returns to the opener on unmount. */
export function trapFocus(node: HTMLElement): Action {
  const opener = document.activeElement as HTMLElement | null;
  queueMicrotask(() => { const f = focusables(node); (f[0] ?? node).focus(); });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const ring = focusables(node);
    if (!ring.length) { e.preventDefault(); return; }
    const to = tabTarget(ring, document.activeElement, e.shiftKey, node.contains(document.activeElement));
    if (to) { e.preventDefault(); to.focus(); }
  };
  node.addEventListener("keydown", onKey);
  return { destroy() { node.removeEventListener("keydown", onKey); try { opener?.focus(); } catch {} } };
}

/** DOCKED, NOT MODAL: takes focus on open and hands it back on close, and deliberately does not trap —
 *  the toolbar stays operable while a card is open, which is the whole difference between a pane and a
 *  dialog. Kept beside trapFocus so the distinction is visible in one place rather than inferred. */
export function focusOnOpen(node: HTMLElement): Action {
  const opener = document.activeElement as HTMLElement | null;
  queueMicrotask(() => { try { node.focus(); } catch {} });
  return { destroy() { try { opener?.focus(); } catch {} } };
}
