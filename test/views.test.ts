// SAVED VIEWS in the .eido (eid-thbs): the container carries `views` — named ViewState objects, the
// same shape the viewer's URL (de)serializes, but UNCAPPED: full card-id lists for selections and
// derived-axis examples, with no reference to URL capacity anywhere. This test proves the save→encode→
// decode→open loop returns the IDENTICAL state object, and that files without views stay readable.
import { test, expect } from "bun:test";
import { encodeMap, decodeMap } from "../src/mapbin.ts";
import type { SavedView, ViewState } from "../src/schema.ts";
import { synthMap } from "../e2e/synth.ts";

test("views: a saved ViewState round-trips the container byte-exactly, full ids, no cap", () => {
  const D = synthMap();
  // a deliberately BIG state: a 60-card selection and a derived axis with 30 full example ids — far past
  // anything a URL would carry uncapped. The file has no length problem, so nothing may drop.
  const state: ViewState = {
    layout: "axes",
    channels: { color: "d0", size: "hub", x: "a", y: "b", z: "a", scrub: "hub", sort: "hub" },
    grain: 3,
    dimProps: { a: { norm: "honest", invert: true }, d0: { norm: "rank", invert: false } },
    window: { lo: 2, hi: 4 },
    region: 5,
    find: "beta",
    queries: ["arguments about scaling"],
    derived: [{ label: "blobby", key: "d0", ids: Array.from({ length: 30 }, (_, i) => "d" + (30 + i)) }],
    selection: Array.from({ length: 60 }, (_, i) => "d" + i),
    camera: { target: [1.6, 1.1, 0], zoom: 7.25, rot: null, rotX: null },
  };
  const view: SavedView = { name: "the beta clump", created: 1754700000000, state };
  D.views = [view];
  const back = decodeMap(encodeMap(D));
  expect(back.views).toEqual([view]);                       // identical state object, nothing dropped
  expect(back.views![0].state.selection!.length).toBe(60);  // full ids, uncapped
  expect(back.views![0].state.derived![0].ids.length).toBe(30);
});

test("views: multiple views append in order; a file without views stays readable (views absent)", () => {
  const D = synthMap();
  const v = (name: string, layout: ViewState["layout"]): SavedView => ({ name, created: Date.now(), state: { layout, channels: { color: "region" }, grain: 2 } });
  D.views = [v("first", "mde"), v("second", "orbit")];
  const back = decodeMap(encodeMap(D));
  expect(back.views!.map((x) => x.name)).toEqual(["first", "second"]);

  const plain = decodeMap(encodeMap(synthMap()));           // no views section at all
  expect(plain.views).toBeUndefined();
});
