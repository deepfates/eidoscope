import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFolder, splitOversized, type Doc } from "../src/corpus.ts";
import { trajectory } from "../src/trajectory.ts";
import { deckToJSONL, cardCorpus, type Card } from "../src/card.ts";
import { cardText, projectionScores } from "../src/map.ts";
import { scoreRedundancy } from "../src/redundancy.ts";
import { docArxiv, fetchFrontier } from "../src/frontier.ts";
import { distinctiveTerms, distinctiveAxes, nameLevels } from "../src/regions.ts";
import { renderHTML, type MapData } from "../src/render.ts";
import { relabelMap } from "../src/pipeline.ts";
import { encodeMap, decodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";

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

test("splitOversized: only oversized docs split; pieces are contiguous, lossless, and ordered", () => {
  const short: Doc = { id: "s", title: "Short", body: "word ".repeat(20).trim() };            // 99 chars, under max
  const bigBody = Array.from({ length: 500 }, (_, i) => "w" + i).join(" ");                     // ~2900 chars
  const big: Doc = { id: "b", title: "Big Book", body: bigBody, url: "file:///x", author: "A" };
  const { docs, split, pieces } = splitOversized([short, big], 1000);
  expect(split).toBe(1);                                                                        // only the big one split
  const shortOut = docs.filter((d) => d.id === "s");
  expect(shortOut.length).toBe(1); expect(shortOut[0].body).toBe(short.body);                   // short doc untouched
  const parts = docs.filter((d) => d.id.startsWith("b#"));
  expect(parts.length).toBe(pieces);
  expect(parts.every((p) => p.body.length <= 1000)).toBe(true);                                 // every piece fits the max
  // LOSSLESS: joining the pieces back reproduces the original body exactly (contiguous, nothing dropped/dup'd)
  expect(parts.map((p) => p.body).join("")).toBe(bigBody);
  expect(parts.every((p) => p.url === "file:///x" && p.author === "A")).toBe(true);             // metadata carried to each piece
  expect(parts.map((p) => p.title)).toEqual(parts.map((_, k) => `Big Book (part ${k + 1}/${parts.length})`));
  expect(splitOversized([big], 0).split).toBe(0);                                               // maxChars<=0 disables splitting
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

test("distinctiveTerms: a term common ACROSS the corpus never headlines a region (document-frequency filter)", () => {
  // every doc says "common"; only group 0 also says "poison", only group 1 "sword".
  const cores = [
    "common poison poison venom", "common poison antidote", "common poison toxin",   // group 0: poisons
    "common sword blade steel", "common sword parry", "common sword hilt",           // group 1: blades
  ];
  const groups = [[0, 1, 2], [3, 4, 5]];
  const terms = distinctiveTerms(cores, groups, { top: 3, minDocs: 2 });
  expect(terms[0]).not.toContain("common");   // in every doc → filtered by df, can't headline either region
  expect(terms[1]).not.toContain("common");
  expect(terms[0]).toContain("poison");        // each region named by its OWN over-used vocabulary
  expect(terms[1]).toContain("sword");
  expect(terms[0]).not.toContain("sword");
});

test("distinctiveTerms: coverage weighting — with EQUAL total count, the term spread across more docs ranks first", () => {
  // "shared" and "codeword" have the SAME total count (12) and same corpus-distinctiveness — they differ
  // ONLY in spread: "shared" across 4 region docs, "codeword" concentrated in 2. Coverage must rank shared
  // first (this is what stops a class-specific term hammered by a few docs from headlining a broad region).
  const d0 = "shared shared shared codeword codeword codeword codeword codeword codeword";
  const region = [d0, d0, "shared shared shared", "shared shared shared"]; // shared: 4 docs; codeword: 2 docs; both count 12
  const other = Array.from({ length: 8 }, (_, i) => "context" + i);          // dilute corpus df so neither is "common"
  const terms = distinctiveTerms([...region, ...other], [[0, 1, 2, 3]], { top: 3, minDocs: 2 });
  expect(terms[0][0]).toBe("shared");                        // more spread wins at equal count
  expect(terms[0].indexOf("codeword")).toBeGreaterThan(0);  // still present (2 docs ≥ minDocs), just ranked below
});

test("distinctiveAxes: ranks a region's most extreme axes with the pole it leans toward", () => {
  const axes = [{ key: "a", name: "AxisA", low: "LowA", high: "HighA" }, { key: "b", name: "AxisB", low: "LowB", high: "HighB" }];
  const scores = { a: [90, 92, 88, 50], b: [51, 49, 50, 50] }; // group is extreme-high on a, centered on b
  const d = distinctiveAxes(scores, axes, [0, 1, 2]);
  expect(d[0].name).toBe("AxisA");           // most extreme axis first
  expect(d[0].pole).toBe("HighA");           // leans to the high pole
  expect(d[0].mean).toBe(90);
  expect(d[1].name).toBe("AxisB");           // the centered axis ranks last
});

// A tiny synthetic map with a NESTED 2-level grain ladder: level0 has 2 regions, level1 splits the
// first into two → 3 regions. Enough to exercise the whole viewer + relabel contract without an embedder.
function synthMap(): MapData {
  const N = 6;
  const axes = [{ key: "a", name: "AxisA", low: "LowA", high: "HighA" }, { key: "b", name: "AxisB", low: "LowB", high: "HighB" }];
  return {
    ids: Array.from({ length: N }, (_, i) => "d" + i),
    titles: Array.from({ length: N }, (_, i) => "Title " + i),
    cores: ["poison venom toxin", "poison antidote", "poison cure", "sword blade steel", "sword hilt", "sword parry"],
    notes: Array.from({ length: N }, () => ({ a: "noteA", b: "noteB" })),
    axes,
    scores: { a: [90, 88, 92, 10, 12, 8], b: [50, 52, 48, 51, 49, 50] },
    xy: Array.from({ length: N }, (_, i) => [i < 3 ? -0.5 : 0.5, (i % 3) * 0.2]),
    xyz: Array.from({ length: N }, (_, i) => [i < 3 ? -0.5 : 0.5, 0, 0]),
    cluster: [0, 0, 0, 1, 1, 1], k: 2,
    hub: Array.from({ length: N }, () => 1), nbr: Array.from({ length: N }, (_, i) => [(i + 1) % N]),
    clusters: [{ c: 0, n: 3, label: "old0", cx: -0.5, cy: 0 }, { c: 1, n: 3, label: "old1", cx: 0.5, cy: 0 }],
    levels: [[0, 0, 0, 1, 1, 1], [0, 0, 1, 2, 2, 2]], counts: [2, 3], di: 0,
    levelLabels: [["old0", "old1"], ["oldA", "oldB", "oldC"]],
  };
}

test("mapbin: binary codec round-trips the contract losslessly and is much smaller than JSON", () => {
  const D: MapContract = {
    ids: ["a", "b", "c"], titles: ["A", "B", "C"], cores: ["core a", "core b", "core c"],
    notes: [{ x: "nx" }, { x: "ny" }, { x: "nz" }],
    axes: [{ key: "x", name: "X", low: "lo", high: "hi" }],
    scores: { x: [10, 55, 90] },
    xy: [[-0.5, 0.1], [0.2, -0.3], [0.9, 0.4]], xyz: [[-0.5, 0.1, 0], [0.2, -0.3, 0.1], [0.9, 0.4, -0.2]],
    cluster: [0, 0, 1], k: 2, di: 1,
    levels: [[0, 0, 0], [0, 0, 1]], counts: [1, 2], levelLabels: [["all"], ["p", "q"]],
    clusters: [{ c: 0, n: 2, label: "p" }, { c: 1, n: 1, label: "q" }],
    hub: [3, 1, 2], nbr: [[1, 2], [0], [0, 1]],
    urls: ["u", undefined, "w"], sources: ["arxiv.org/abs/1", undefined, "blog/3"], siteNames: ["arXiv.org", undefined, "Blog"], dates: [1, 2, 3],
    provenance: { title: "Test Corpus", source: "/x/y", generated: 1722556800000, count: 3 },
  };
  const bin = encodeMap(D);
  const back = decodeMap(bin);
  expect(back.ids).toEqual(D.ids);                                   // strings survive (JSON header)
  expect(back.cluster).toEqual(D.cluster);                          // int buffer
  expect(back.levels).toEqual(D.levels);                            // ragged int buffers
  expect(back.nbr).toEqual(D.nbr);                                  // ragged neighbor lists
  expect(back.scores.x.map((v) => Math.round(v))).toEqual(D.scores.x); // f32 scores
  expect(back.xy[2][0]).toBeCloseTo(0.9, 4);                        // f32 coords
  expect(back.urls).toEqual(D.urls);                                // sparse metadata (undefined preserved)
  expect(back.sources).toEqual(D.sources);                          // original source links survive round-trip
  expect(back.siteNames).toEqual(D.siteNames);                      // and their labels
  expect(back.provenance).toEqual(D.provenance);                    // provenance (so a file introduces itself) survives
  expect(bin.byteLength).toBeLessThan(JSON.stringify(D).length);    // smaller than the JSON form
});

test("mapbin v2: carries f16 card vectors + derivedBy, preserves ranking, and stays back/forward-compatible", () => {
  const dim = 12, n = 24;
  const vecs = Array.from({ length: n }, (_, i) => { const v = Array.from({ length: dim }, (_, j) => Math.sin(i * 0.9 + j * 1.3)); const norm = Math.hypot(...v); return v.map((x) => x / norm); });
  const D: MapContract = {
    version: 2, ids: Array.from({ length: n }, (_, i) => "d" + i), titles: Array.from({ length: n }, (_, i) => "T" + i),
    cores: Array.from({ length: n }, (_, i) => "c" + i), notes: Array.from({ length: n }, () => ({ x: "n" })),
    axes: [{ key: "x", name: "X", low: "lo", high: "hi" }], scores: { x: Array.from({ length: n }, (_, i) => (i / n) * 100) },
    xy: Array.from({ length: n }, (_, i) => [Math.cos(i), Math.sin(i)]), xyz: Array.from({ length: n }, (_, i) => [Math.cos(i), Math.sin(i), 0]),
    cluster: Array.from({ length: n }, (_, i) => i % 2), k: 2, di: 0, clusters: [{ c: 0, n: 12, label: "p" }, { c: 1, n: 12, label: "q" }],
    hub: Array.from({ length: n }, () => 1), nbr: Array.from({ length: n }, (_, i) => [(i + 1) % n]),
    derivedBy: { cardModel: "test/model", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim, pooling: "mean", normalized: true }, geometryBasis: "card", generated: 7 },
    vectors: vecs,
  };
  const back = decodeMap(encodeMap(D));
  expect(back.version).toBe(2);
  expect(back.derivedBy).toEqual(D.derivedBy);                       // provenance record survives exactly
  expect(back.vectors!.length).toBe(n);
  expect(back.vectors![0].length).toBe(dim);
  // f16 is lossy in the last bits but must preserve the custom-axis RANKING (the thing it's for)
  let maxErr = 0; for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) maxErr = Math.max(maxErr, Math.abs(vecs[i][j] - back.vectors![i][j]));
  expect(maxErr).toBeLessThan(1e-3);
  const q = vecs[5], dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const rank = (vs: number[][]) => vs.map((_, i) => i).sort((a, b) => dot(q, vs[b]) - dot(q, vs[a]));
  expect(rank(back.vectors!)).toEqual(rank(vecs));                   // projection ranking identical after f16 round-trip

  // back-compat: a LITE emit (no vectors/derivedBy) decodes with those absent, nothing else lost
  const { vectors, derivedBy, ...lite } = D;
  const backLite = decodeMap(encodeMap(lite as MapContract));
  expect(backLite.vectors).toBeUndefined();
  expect(backLite.derivedBy).toBeUndefined();
  expect(backLite.ids).toEqual(D.ids);
});

test("renderHTML: viewer script parses AND the grain ladder actually reaches the payload (both bugs I shipped)", () => {
  const html = renderHTML(synthMap());
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  expect(() => new Function(script)).not.toThrow();               // catches syntax bugs (e.g. a backtick inside the template)
  const payload = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)![1].replace(/<\\\//g, "</"));
  expect(payload.levels.length).toBe(2);                          // the ladder is SHIPPED, not thrown away
  expect(payload.counts).toEqual([2, 3]);
  expect(payload.levelLabels.length).toBe(2);
  expect(payload.nodes.length).toBe(6);
  expect(html).toContain('id="grain"');                          // the grain slider control is rendered
});

test("relabelMap: end-to-end — names every grain level, picks the ~18 default, rebuilds regions (mock LLM)", async () => {
  let calls = 0;
  const sig = { forward: async (_llm: any, inp: any) => { calls++; return { regionLabel: "R:" + inp.distinctiveTerms.split(",")[0].trim(), regionBlurb: "b" }; } };
  const D2 = await relabelMap(synthMap(), { llm: {}, sig, quiet: true });
  expect(D2.levelLabels!.length).toBe(2);
  expect(D2.levelLabels![0].length).toBe(2);                     // level 0: 2 regions named
  expect(D2.levelLabels![1].length).toBe(3);                     // level 1: 3 regions named
  expect(D2.di).toBe(1);                                          // counts [2,3] → 3 is nearer 18 → default level 1
  expect(D2.k).toBe(3);
  expect(D2.clusters.length).toBe(3);                             // default-grain regions rebuilt from level 1
  expect(D2.clusters.every((c) => c.label.startsWith("R:"))).toBe(true); // labels come from the (mock) namer
  // the poison region is named from its OWN distinctive term, not a shared one
  expect(D2.clusters.some((c) => c.label.includes("poison"))).toBe(true);
});

test("nameLevels: a region unchanged across grain levels is named ONCE (dedup), not per level", async () => {
  let calls = 0;
  const sig = { forward: async () => { calls++; return { regionLabel: "R" + calls, regionBlurb: "" }; } };
  // region {3,4,5} is identical in both levels; only {0,1,2} splits → 4 UNIQUE member-sets, not 5
  const levels = [[0, 0, 0, 1, 1, 1], [0, 0, 1, 2, 2, 2]], counts = [2, 3];
  const cores = ["a", "b", "c", "d", "e", "f"], titles = cores;
  const axes = [{ key: "a", name: "A", low: "lo", high: "hi" }];
  const scores = { a: [1, 2, 3, 4, 5, 6] };
  const { labels } = await nameLevels(levels, counts, titles, cores, scores, axes, { llm: {}, sig, concurrency: 1 });
  expect(calls).toBe(4);                                          // {0,1,2},{3,4,5} (L0) + {0,1},{2} (L1); {3,4,5} reused
  expect(labels[0].length).toBe(2); expect(labels[1].length).toBe(3);
});

test("cardCorpus: cards cache by content + axis GEOMETRY; relabeling axes hits (the re-card fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cache-"));
  const geom = { pc: 1, var: 0.5, coherence: 5, pole_low: "", pole_high: "" };
  const axesA = [{ ...geom, key: "a", name: "A" }] as any;                              // geometry G, labeled "A"
  const axesRelabeled = [{ ...geom, key: "scholarly", name: "Scholarly" }] as any;      // SAME geometry, LLM renamed it
  const axesNewGeom = [{ pc: 2, var: 0.3, coherence: 5, key: "c", name: "C", pole_low: "", pole_high: "" }] as any; // different geometry
  const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: `T${i}`, body: "word ".repeat(50) }));
  let calls = 0;
  const sig = { forward: async () => { calls++; return { restatement: "r", axisPlacements: ["n"] }; } };
  const opts = { sig, cache: dir, concurrency: 1, llm: {} };

  const r1 = await cardCorpus(docs(3), axesA, opts);
  expect(r1.length).toBe(3); expect(calls).toBe(3); // all fresh — one call per doc

  await cardCorpus(docs(3), axesA, opts); // same corpus + axes → all cached, survived a "restart"
  expect(calls).toBe(3);

  const r3 = await cardCorpus(docs(3), axesRelabeled, opts); // axes RELABELED, geometry identical → HIT
  expect(r3.length).toBe(3);
  expect(calls).toBe(3); // the re-card fix: nondeterministic label drift does NOT re-card

  const r4 = await cardCorpus(docs(3), axesNewGeom, opts); // geometry ACTUALLY changed → re-card (correct)
  expect(r4.length).toBe(3);
  expect(calls).toBe(6);

  rmSync(dir, { recursive: true, force: true });
});
