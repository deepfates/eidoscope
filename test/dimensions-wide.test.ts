import { test, expect } from "bun:test";
import { buildDimensions, LEGIBLE_VALUES } from "../viewer/src/dimensions.ts";
import type { MapContract } from "../src/schema.ts";

// eid-ml88: a categorical with more values than colour can speak about must still EXIST — sorting the
// deck by artist, isolating one, or finding by album are the whole point of carrying the column. Only
// colour declines it. Cardinality is a channel's affordance, never a reason to delete a dimension.
const mapWith = (n: number, distinct: number): MapContract => ({
  ids: Array.from({ length: n }, (_, i) => "d" + i),
  titles: Array.from({ length: n }, (_, i) => "t" + i),
  cores: Array.from({ length: n }, () => "core"),
  notes: Array.from({ length: n }, () => ({})),
  axes: [], scores: {}, xy: [], xyz: [], cluster: [], k: 0, clusters: [], hub: [], nbr: [],
  cols: [{ key: "artist", label: "artist", type: "categorical", values: Array.from({ length: n }, (_, i) => "artist-" + (i % distinct)) }],
  metaFields: [{ key: "artist", label: "artist", type: "categorical", source: "mcol:artist" }],
} as unknown as MapContract);

test("a wide categorical stays a dimension, flagged so colour can decline it", () => {
  const wide = buildDimensions(mapWith(500, LEGIBLE_VALUES + 60)).find((d) => d.key === "artist");
  expect(wide).toBeDefined();                 // present — NOT deleted for being wide
  expect(wide!.wide).toBe(true);
  expect(wide!.cat!(0)).toBe("artist-0");     // and fully usable: values resolve for sort/find/facet
  const narrow = buildDimensions(mapWith(500, 5)).find((d) => d.key === "artist");
  expect(narrow!.wide).toBeFalsy();           // a legible one is colourable as before
});

test("a single-valued or mostly-absent column is still dropped (no information to carry)", () => {
  expect(buildDimensions(mapWith(500, 1)).find((d) => d.key === "artist")).toBeUndefined();
  const sparse = mapWith(500, 10);
  sparse.cols![0].values = sparse.cols![0].values.map((v, i) => (i < 100 ? v : undefined)) as any;
  expect(buildDimensions(sparse).find((d) => d.key === "artist")).toBeUndefined();
});
