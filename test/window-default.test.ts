// Which dimension the WINDOW opens on (eid-m6l8). Measured on the two shipped corpora: pathfinder.eido
// has 13,796 documents, 0 of them dated and no temporal field at all, and the control used to open
// parked on "Scholarly vs Alchemical Combat -0.51 – 0.57" — a unitless PCA projection, legal to window
// and nearly meaningless as a filter. map.eido has 1,383 of 1,385 dated and the same control is genuinely
// useful. The property under test is the ORDER OF PREFERENCE, not any particular key.
import { test, expect } from "bun:test";
import { buildDimensions } from "../viewer/src/dimensions.ts";
import type { MapContract } from "../src/schema.ts";

// Only the fields the dimension registry reads; the window cares about scalars and temporals.
const mapWith = (opts: { dated?: boolean }): MapContract => {
  const n = 6;
  return {
    ids: Array.from({ length: n }, (_, i) => "d" + i),
    titles: Array.from({ length: n }, (_, i) => "t" + i),
    cores: Array.from({ length: n }, () => "core"),
    notes: Array.from({ length: n }, () => ({})),
    // one discovered axis, exactly the kind of unitless projection the bug opened on
    axes: [{ key: "pc0", name: "Scholarly vs Alchemical Combat", low: "a", high: "b" }],
    scores: { pc0: Array.from({ length: n }, (_, i) => i * 10) },
    xy: [], xyz: [], cluster: [], k: 0, clusters: [],
    hub: Array.from({ length: n }, (_, i) => i),          // a metadata scalar with real units
    nbr: [],
    // The registry builds metadata dims from the file's own typed manifest, so a corpus "has a timeline"
    // exactly when it DECLARES one — which is what the two shipped corpora differ on: map.eido declares
    // date:temporal, pathfinder.eido declares no temporal field at all.
    metaFields: [
      { key: "hub", label: "connections", type: "scalar", source: "col:hub" },
      ...(opts.dated ? [{ key: "date", label: "date", type: "temporal", source: "col:dates" }] : []),
    ],
    ...(opts.dated ? { dates: Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i * 86_400_000) } : {}),
  } as unknown as MapContract;
};

// mirrors ViewModel.ensureScrubKey's preference, over the real registry the app builds
const windowDefault = (D: MapContract): string | undefined => {
  const fields = buildDimensions(D).filter((d) => d.kind === "scalar" || d.kind === "temporal");
  const pick = fields.find((d) => d.kind === "temporal")
    ?? fields.find((d) => d.source === "meta")
    ?? fields[0];
  return pick?.key;
};

test("a corpus WITH dates opens the window on its timeline", () => {
  const dims = buildDimensions(mapWith({ dated: true }));
  expect(dims.some((d) => d.kind === "temporal")).toBe(true);   // the fixture exercises this branch
  const pick = dims.find((d) => d.key === windowDefault(mapWith({ dated: true })));
  expect(pick?.kind).toBe("temporal");
});

// The bug itself: no timeline, so it must fall to something with units — never to a discovered axis.
test("a corpus with NO dates opens on a metadata scalar, not a unitless PCA axis", () => {
  const D = mapWith({ dated: false });
  const dims = buildDimensions(D);
  expect(dims.some((d) => d.kind === "temporal")).toBe(false);  // this fixture exercises the other branch
  expect(dims.some((d) => d.source === "axis" && d.kind === "scalar")).toBe(true);  // and an axis IS available to wrongly pick
  const pick = dims.find((d) => d.key === windowDefault(D));
  expect(pick?.source).toBe("meta");
  expect(pick?.source).not.toBe("axis");
});
