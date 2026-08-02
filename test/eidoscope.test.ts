import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFolder } from "../src/corpus.ts";
import { trajectory } from "../src/trajectory.ts";
import { deckToJSONL, cardCorpus, type Card } from "../src/card.ts";
import { cardText, projectionScores } from "../src/map.ts";
import { scoreRedundancy } from "../src/redundancy.ts";
import { docArxiv, fetchFrontier } from "../src/frontier.ts";

// Deterministic contract tests — the pure pipeline surfaces. Fast, no LLM/network.
// (The LLM stages take an injectable `llm`; a live smoke test is gated behind EIDOSCOPE_LIVE.)

test("loadFolder: parses frontmatter, derives titles, skips short docs", () => {
  const d = mkdtempSync(join(tmpdir(), "eido-"));
  writeFileSync(join(d, "a.md"), `---\nid: "x1"\ntitle: "Alpha"\ncreated_at: "2025-01-01"\n---\n${"word ".repeat(80)}`);
  writeFileSync(join(d, "b.md"), `# Beta Heading\n\n${"lorem ".repeat(80)}`);
  writeFileSync(join(d, "tiny.md"), "too short");
  writeFileSync(join(d, "c.md"), `# Gamma\n\nSee https://arxiv.org/abs/2401.00001 for the method. ${"word ".repeat(80)}`);
  const docs = loadFolder(d);
  rmSync(d, { recursive: true, force: true });
  expect(docs.length).toBe(3); // tiny.md dropped by minChars
  const a = docs.find((x) => x.id === "x1")!;
  expect(a.title).toBe("Alpha");
  expect(a.date).toBeGreaterThan(0);
  expect(a.path).toMatch(/^\/.*a\.md$/); // absolute path always kept -> "open source" works with no metadata
  expect(docs.find((x) => x.title === "Beta Heading")).toBeTruthy(); // title from # heading
  const c = docs.find((x) => x.title === "Gamma")!;
  expect(c.url).toBe("https://arxiv.org/abs/2401.00001"); // url pulled from body when frontmatter lacks it
});

test("trajectory: flags the late-loaded region as rising and reports drift", () => {
  const n = 40;
  const dates = Array.from({ length: n }, (_, i) => Date.parse("2025-01-01") + i * 86400000);
  const cluster = Array.from({ length: n }, (_, i) => (i < 20 ? 0 : 1)); // 0=early half, 1=late half
  const scores = { a: Array.from({ length: n }, (_, i) => (i < 20 ? 20 : 80)) };
  const md = trajectory({ dates, cluster, scores, axes: [{ key: "a", name: "AxisA", low: "LowPole", high: "HighPole" }], clusters: [{ c: 0, n: 20, label: "EarlyRegion" }, { c: 1, n: 20, label: "LateRegion" }] })!;
  expect(md).toBeTruthy();
  expect(md).toMatch(/rising.*LateRegion/);
  expect(md).toMatch(/cooling.*EarlyRegion/);
  expect(md).toMatch(/AxisA.*HighPole/); // drift 20 -> 80 heads toward the high pole
});

test("trajectory: skips a corpus without enough dates", () => {
  expect(trajectory({ dates: [], cluster: [0], scores: {}, axes: [], clusters: [] })).toBeNull();
});

test("deck: round-trips through JSONL, one card per line", () => {
  const cards: Card[] = [
    { id: "1", title: "T1", core: "core one", axes: { a: { note: "n1" } } },
    { id: "2", title: "T2", core: "core two", axes: { a: { note: "n2" } } },
  ];
  const lines = deckToJSONL(cards).trim().split("\n");
  expect(lines.length).toBe(2);
  const back = JSON.parse(lines[0]);
  expect(back.id).toBe("1");
  expect(back.axes.a.note).toBe("n1");
});

test("cardText: embeds the title, core, and every axis note (the de-noised text)", () => {
  const c: Card = { id: "1", title: "The Title", core: "The core.", axes: { a: { note: "noteAlpha" }, b: { note: "noteBeta" } } };
  const axes = [{ pc: 1, var: 0, coherence: 5, key: "a", name: "A", pole_low: "", pole_high: "" }, { pc: 2, var: 0, coherence: 5, key: "b", name: "B", pole_low: "", pole_high: "" }];
  const t = cardText(c, axes as any);
  expect(t).toContain("The Title");        // title carries named entities the summary may drop
  expect(t).toContain("The core.");
  expect(t).toContain("noteAlpha");
  expect(t).toContain("noteBeta");
  expect(t.indexOf("The Title")).toBeLessThan(t.indexOf("The core.")); // title leads
});

test("projectionScores: rank-normalizes a PCA column to 0-100, no saturation, orientation preserved", () => {
  // three docs low on PC0, three high; projectionScores should spread them across the full range
  const projections = [[-5, 0.2], [-3, -1], [-1, 0.5], [1, -0.3], [3, 0.1], [9, -0.7]];
  const s = projectionScores(projections, [{ key: "x", pc: 1 }]);            // pc=1 → column 0
  expect(s.x.length).toBe(6);
  expect(Math.min(...s.x)).toBe(0);                                          // lowest projection → 0
  expect(Math.max(...s.x)).toBe(100);                                        // highest → 100
  expect(new Set(s.x).size).toBe(6);                                         // all distinct — no bucketing
  // monotonic in the projection: argmin projection maps to 0, argmax to 100
  expect(s.x[0]).toBe(0);
  expect(s.x[5]).toBe(100);
});

test("frontier: docArxiv extracts ids; fetchFrontier no-ops cleanly without arxiv (no network)", async () => {
  expect(docArxiv({ body: "see arxiv.org/abs/1706.03762 for details" })).toBe("1706.03762");
  expect(docArxiv({ body: "arXiv:2005.14165 (GPT-3)" })).toBe("2005.14165");
  expect(docArxiv({ body: "no papers here, just prose about cooking" })).toBeNull();
  const f = await fetchFrontier([{ id: "a", title: "T", body: "prose only, no ids" }]);
  expect(f.corpusArxiv).toBe(0);      // nothing to fetch → no network call
  expect(f.ranked.length).toBe(0);
  expect(f.cite).toEqual([[]]);
});

test("scoreRedundancy: flags collapsed axes, passes distinct ones", () => {
  const a = Array.from({ length: 60 }, (_, i) => i);
  const b = a.map((x) => 2 * x + 5);                       // perfectly correlated with a -> |r|=1
  const c = a.map((i) => (i % 2 === 0 ? i : 60 - i));      // zigzag, low correlation with a
  const collapsed = scoreRedundancy({ a, b, c });
  const ab = collapsed.pairs.find((p) => (p.a === "a" && p.b === "b") || (p.a === "b" && p.b === "a"))!;
  expect(Math.abs(ab.r)).toBeGreaterThan(0.99);            // a~b detected as redundant
  expect(collapsed.strong).toBeGreaterThanOrEqual(1);
  expect(collapsed.pass).toBe(false);                      // a duplicate axis fails the guard

  const distinct = scoreRedundancy({ x: a, y: c, z: a.map((i) => (i * 7) % 11) });
  expect(distinct.meanAbsR).toBeLessThan(collapsed.meanAbsR);
});

test("cardCorpus: cores cache by content forever; relabeling axes only re-places (the re-card fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cache-"));
  const axesA = [{ pc: 1, var: 0, coherence: 5, key: "a", name: "A", pole_low: "", pole_high: "" }] as any;
  const axesB = [{ pc: 1, var: 0, coherence: 5, key: "b", name: "B", pole_low: "", pole_high: "" }] as any;
  const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: `T${i}`, body: "word ".repeat(50) }));
  let coreCalls = 0, placeCalls = 0;
  const deriveCoreSig = { forward: async (_llm: any, inp: any) => { coreCalls++; return { restatement: "r-" + inp.documentTitle }; } };
  const placeSig = { forward: async () => { placeCalls++; return { axisPlacements: ["n"] }; } };
  const opts = { deriveCoreSig, placeSig, cache: dir, concurrency: 1, llm: {} };

  const r1 = await cardCorpus(docs(3), axesA, opts);
  expect(r1.length).toBe(3); expect(coreCalls).toBe(3); expect(placeCalls).toBe(3); // all fresh

  await cardCorpus(docs(3), axesA, opts); // same docs+axes → both caches hit, survived a "restart"
  expect(coreCalls).toBe(3); expect(placeCalls).toBe(3);

  const r3 = await cardCorpus(docs(4), axesA, opts); // one new doc → only it is cored+placed
  expect(r3.length).toBe(4); expect(coreCalls).toBe(4); expect(placeCalls).toBe(4);

  const r4 = await cardCorpus(docs(4), axesB, opts); // AXES RELABELED: cores reused, only placements redo
  expect(r4.length).toBe(4);
  expect(coreCalls).toBe(4);   // the whole point — the expensive restatements are NOT re-derived
  expect(placeCalls).toBe(8);  // 4 docs re-placed onto the new axes (the cheap half)

  rmSync(dir, { recursive: true, force: true });
});
