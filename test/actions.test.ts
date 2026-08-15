// Focus-ring arithmetic for the app's overlays (eid-sh90 factoring).
//
// A focus trap is the kind of thing that is either exactly right or quietly broken for keyboard users,
// and nobody notices for months. This lived in App.svelte and had no coverage; the decision it makes is
// small enough to state as a function, so here it is stated.
import { test, expect } from "bun:test";
import { tabTarget } from "../viewer/src/actions";

const ring = ["first", "mid", "last"] as unknown as HTMLElement[];
const [first, mid, last] = ring;

// The trap intervenes at exactly two places. Everywhere else the browser's own Tab order is correct, and
// a trap that redirected every Tab would break arrow-key/typeahead behaviour inside menus and listboxes.
test("Tab in the middle of the ring is left alone", () => {
  expect(tabTarget(ring, mid, false, true)).toBeNull();
  expect(tabTarget(ring, mid, true, true)).toBeNull();
});

test("Tab off the end wraps to the start, and Shift+Tab off the start wraps to the end", () => {
  expect(tabTarget(ring, last, false, true)).toBe(first);
  expect(tabTarget(ring, first, true, true)).toBe(last);
});

// Focus can be outside the dialog when it opens (the opener still has it, or the user clicked the
// backdrop). Shift+Tab must then pull INTO the ring rather than escaping to the page behind the modal.
test("Shift+Tab from outside the dialog pulls back into the ring", () => {
  expect(tabTarget(ring, null, true, false)).toBe(last);
  expect(tabTarget(ring, mid, true, false)).toBe(last);
});

test("an empty ring has nowhere to send focus, and says so instead of guessing", () => {
  expect(tabTarget([], null, false, true)).toBeNull();
  expect(tabTarget([], null, true, false)).toBeNull();
});

// A dialog with exactly one focusable control is the degenerate case the welcome modal actually is:
// first === last, so both wrap directions must land on it rather than falling through to the page.
test("a single-control dialog keeps focus on that control in both directions", () => {
  const one = ["only"] as unknown as HTMLElement[];
  expect(tabTarget(one, one[0], false, true)).toBe(one[0]);
  expect(tabTarget(one, one[0], true, true)).toBe(one[0]);
});
