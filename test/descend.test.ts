import { test, expect } from "bun:test";
import { descendMap } from "../src/pipeline.ts";
import { descendMap as engineDescend } from "../src/engine.ts";
import { encodeMap, decodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";
import { mulberry32 } from "../src/axes.ts";

// DESCEND v0 (eid-nuwd) — deterministic contract tests, no LLM/network: discovery falls back to PC names
// when the (empty) llm fails, and region naming takes an injected mock sig, same pattern as relabelMap's test.

// A parent map whose vectors have real structure: two clumps in 8-dim space + a little seeded noise,
// so descent over one clump still finds an axis and clusters. 12 docs, ids d0..d11.
function synthParent(): MapContract {
  const N = 12, D = 8, rnd = mulberry32(7);
  const rows = Array.from({ length: N }, (_, i) =>
    Array.from({ length: D }, (_, j) => (j === 0 ? (i < 6 ? 1 : -1) : j === 1 ? (i % 2 ? 0.8 : -0.8) : 0) + (rnd() - 0.5) * 0.2));
  const vectors = { data: Float32Array.from(rows.flat()), dim: D };   // schema CardVectors: flat row-major
  return {
    ids: Array.from({ length: N }, (_, i) => "d" + i),
    titles: Array.from({ length: N }, (_, i) => "Title " + i),
    cores: Array.from({ length: N }, (_, i) => (i % 2 ? "poison venom toxin brew" : "sword blade steel forge") + " doc " + i),
    notes: Array.from({ length: N }, () => ({ parent_axis: "a parent-axis placement note" })),
    axes: [{ key: "parent_axis", name: "ParentAxis", low: "L", high: "H" }],
    scores: { parent_axis: Array.from({ length: N }, (_, i) => i * 9) },
    xy: Array.from({ length: N }, (_, i) => [i / N - 0.5, 0]), xyz: Array.from({ length: N }, (_, i) => [i / N - 0.5, 0, 0]),
    cluster: Array.from({ length: N }, (_, i) => (i < 6 ? 0 : 1)), k: 2,
    clusters: [{ c: 0, n: 6, label: "left" }, { c: 1, n: 6, label: "right" }],
    hub: Array.from({ length: N }, () => 1), nbr: Array.from({ length: N }, (_, i) => [(i + 1) % N]),
    cite: Array.from({ length: N }, (_, i) => (i === 0 ? [1, 11] : [])),   // one in-subset edge + one out
    urls: Array.from({ length: N }, (_, i) => "https://x/" + i),
    provenance: { title: "Parent Corpus", count: N },
    derivedBy: { geometryBasis: "card", embedder: { id: "minilm", dim: D } },
    vectors,
  };
}
const mockSig = { forward: async (_llm: any, inp: any) => ({ regionLabel: "R:" + inp.distinctiveTerms.split(",")[0].trim(), regionBlurb: "b" }) };
const selIds = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];
const descend = (P: MapContract, ids = selIds) => descendMap(P, ids, { llm: {}, sig: mockSig, quiet: true });

test("descendMap: re-discovers LOCAL axes over the subset's carried vectors and reuses the cards", async () => {
  const P = synthParent();
  const C = await descend(P);
  expect(C.ids).toEqual(selIds);
  expect(C.titles).toEqual(selIds.map((id) => P.titles[P.ids.indexOf(id)]));       // cards reused verbatim
  expect(C.cores[0]).toContain("sword");
  // NEW local axes, not the parent's — discovered by PCA over the subset vectors (LLM naming failed → PC names)
  expect(C.axes.length).toBeGreaterThanOrEqual(2);
  expect(C.axes.some((a) => a.key === "parent_axis")).toBe(false);
  for (const a of C.axes) expect(C.scores[a.key]!.length).toBe(8);                 // every axis scores every child node
  expect(C.rawScores && Object.keys(C.rawScores).length).toBe(C.axes.length);
  // parent-axis placement notes do NOT carry over (they were written against the parent's axes)
  expect(C.notes.every((n) => Object.keys(n).length === 0)).toBe(true);
  // geometry is the subset's own: node-parallel, fresh clustering
  expect(C.xy.length).toBe(8); expect(C.cluster.length).toBe(8);
  expect(C.clusters.every((c) => c.label.startsWith("R:"))).toBe(true);            // named by the (mock) namer
  expect(C.vectors!.data.length).toBe(8 * 8);                                     // substrate carried (8 rows × dim 8) → grandchild descent works
});

test("descendMap: child provenance records parent map, selection size, and date; derivedBy carries the basis", async () => {
  const P = synthParent();
  const before = Date.now();
  const C = await descend(P);
  expect(C.provenance!.title).toBe("Parent Corpus ▸ descent (8)");
  expect(C.provenance!.source).toContain('descend of "Parent Corpus"');
  expect(C.provenance!.source).toContain("8 of 12 cards");
  expect(C.provenance!.count).toBe(8);
  expect(C.provenance!.generated!).toBeGreaterThanOrEqual(before);
  expect(C.derivedBy!.geometryBasis).toBe("card");                                 // same substrate as the parent — descend adds no model
  expect(C.metaFields!.some((f) => f.key.startsWith("axis:"))).toBe(true);
});

test("descendMap: metadata subsets ride along; citation edges are remapped and out-of-subset ends dropped", async () => {
  const C = await descend(synthParent());
  expect(C.urls).toEqual(selIds.map((id) => "https://x/" + id.slice(1)));
  expect(C.cite![0]).toEqual([1]);                                                 // d0→d1 kept (remapped), d0→d11 dropped
});

test("descendMap: child round-trips through the .eido codec", async () => {
  const C = await descend(synthParent());
  const back = decodeMap(encodeMap(C));
  expect(back.ids).toEqual(C.ids);
  expect(back.axes.map((a) => a.key)).toEqual(C.axes.map((a) => a.key));
  expect(back.provenance!.source).toBe(C.provenance!.source);
  expect(back.vectors!.data.length).toBe(8 * 8);                                   // f16 on the wire, still present
});

// eid-kep3: the page binding (viewer descendInPage) and the CLI both run src/engine.ts descendMap —
// this pins the node wrapper to the engine core: same axes, same scores, same layout, float-for-float.
test("engine descendMap ≡ pipeline descendMap (page-binding parity): axes/scores/xy match within float tolerance", async () => {
  const P = synthParent();
  const A = await descendMap(P, selIds, { llm: {}, sig: mockSig, quiet: true });     // node face
  const B = await engineDescend(P, selIds, { llm: {}, sig: mockSig });               // what the page runs
  expect(B.axes.map((a) => a.key)).toEqual(A.axes.map((a) => a.key));
  expect(B.axes.map((a) => a.variance)).toEqual(A.axes.map((a) => a.variance));
  for (const key of Object.keys(A.scores)) B.scores[key]!.forEach((v, i) => expect(Math.abs(v - A.scores[key][i])).toBeLessThan(1e-9));
  B.xy.forEach((p, i) => { expect(Math.abs(p[0] - A.xy[i][0])).toBeLessThan(1e-9); expect(Math.abs(p[1] - A.xy[i][1])).toBeLessThan(1e-9); });
  expect(B.cluster).toEqual(A.cluster);
  expect(B.clusters.map((c) => c.label)).toEqual(A.clusters.map((c) => c.label));
  expect(B.vectors!.data).toEqual(A.vectors!.data);
});

// eid-kep3: descend WITHOUT an llm — the one place no key is required (the cards already exist).
// Axes wear PC names, regions wear their deterministic contrastive-term labels; nothing errors.
test("engine descendMap with no llm: PC axis names + term region labels, honest and unerrored", async () => {
  const C = await engineDescend(synthParent(), selIds, {});
  expect(C.axes.length).toBeGreaterThanOrEqual(2);
  for (const a of C.axes) { expect(a.name).toMatch(/^PC\d+$/); expect(C.scores[a.key]!.length).toBe(8); }   // unnamed-but-honest
  // regions labeled from the math (distinctive terms), not "region"/empty — and no LLM was ever consulted
  expect(C.clusters.every((c) => c.label.length > 0 && !c.label.startsWith("R:"))).toBe(true);
  expect(C.levelLabels!.every((lvl) => lvl.every((l) => l.length > 0))).toBe(true);
  expect(C.provenance!.title).toBe("Parent Corpus ▸ descent (8)");
});

test("descendMap: fails loud on a lite emit (no vectors), unknown ids, or a too-small selection", async () => {
  const P = synthParent();
  expect(descendMap({ ...P, vectors: undefined }, selIds, { llm: {}, quiet: true })).rejects.toThrow(/no card vectors/);
  expect(descend(P, ["d0", "nope"])).rejects.toThrow(/not in the parent/);
  expect(descend(P, ["d0"])).rejects.toThrow(/at least 2/);
});
