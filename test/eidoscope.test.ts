import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFolder, splitOversized, type Doc } from "../src/corpus.ts";
import { trajectory } from "../src/trajectory.ts";
import { deckToJSONL, cardCorpus, type Card } from "../src/card.ts";
import { cardText, projectionScores, buildMetaFields } from "../src/map.ts";
import { scoreRedundancy } from "../src/redundancy.ts";
import { docArxiv, fetchFrontier } from "../src/frontier.ts";
import { distinctiveTerms, distinctiveAxes, nameLevels } from "../src/regions.ts";

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
function synthMap(): MapContract {
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
    xy: [[-0.5, 0.1], [0.2, -0.3], [0.9, 0.4]], xyz: [[-0.5, 0.1, 0], [0.2, -0.3, 0.1], [0.9, 0.4, -0.2]], xyzAgree: 2.7,
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
  expect(back.xyzAgree).toBe(2.7);                                  // the 2D↔3D neighbor-agreement honesty number (eid-ovo7)
  expect(bin.byteLength).toBeLessThan(JSON.stringify(D).length);    // smaller than the JSON form
  expect(back.rawScores).toBeUndefined();                          // absent when the map carries no raw projections
});

test("mapbin v2.1: notes ride as lazy gzip blocks — exact across block boundaries, and old files still read", () => {
  // n chosen to span multiple 512-card blocks WITH a ragged tail, so block-boundary offsets are exercised
  const n = 1200;
  const D: MapContract = {
    ids: Array.from({ length: n }, (_, i) => "d" + i), titles: Array.from({ length: n }, (_, i) => "T" + i),
    cores: Array.from({ length: n }, (_, i) => "core " + i),
    notes: Array.from({ length: n }, (_, i): Record<string, string> => (i % 7 === 0 ? {} : { x: "note about card #" + i + " — varied length ".repeat(1 + (i % 5)), y: "n" + i })),
    axes: [{ key: "x", name: "X", low: "lo", high: "hi" }], scores: { x: Array.from({ length: n }, (_, i) => (i / n) * 100) },
    xy: Array.from({ length: n }, () => [0, 0]), xyz: Array.from({ length: n }, () => [0, 0, 0]),
    cluster: Array.from({ length: n }, () => 0), k: 1, clusters: [{ c: 0, n, label: "p" }],
    hub: Array.from({ length: n }, () => 1), nbr: Array.from({ length: n }, (_, i) => [(i + 1) % n]),
  };
  const back = decodeMap(encodeMap(D));
  expect(back.notes.length).toBe(n);
  // exact round-trip on EVERY row, including the first/last card of each block and the ragged tail
  for (let i = 0; i < n; i++) expect(back.notes[i]).toEqual(D.notes[i]);
  // a pre-v2.1 file (notes still in the JSON meta, no notes_z blocks) must decode exactly as before:
  // rebuild the container with meta.notes restored — decodeContainer must prefer it over the lazy path.
  const { gunzipSync: gz, gzipSync: rezip } = require("node:zlib");
  const raw = gz(encodeMap(D));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const metaLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + metaLen)));
  expect(meta.notes).toBeUndefined();               // new files carry NO notes in meta …
  expect(meta.buffers.map((b: any) => b.key)).toContain("notes_z");  // … only the gzip blocks
  meta.notes = D.notes;                             // now forge the OLD layout (meta-borne notes)
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const pad = (4 - (metaBytes.byteLength % 4)) % 4, oldPad = (4 - (metaLen % 4)) % 4;
  const body = raw.subarray(12 + metaLen + oldPad);
  const forged = new Uint8Array(12 + metaBytes.byteLength + pad + body.byteLength);
  forged.set(raw.subarray(0, 8), 0);
  new DataView(forged.buffer).setUint32(8, metaBytes.byteLength, true);
  forged.set(metaBytes, 12); forged.set(body, 12 + metaBytes.byteLength + pad);
  const old = decodeMap(rezip(forged));
  for (let i = 0; i < n; i++) expect(old.notes[i]).toEqual(D.notes[i]);
});

test("mapbin: OPTIONAL rawScores (raw PCA projection) round-trips per axis — the honest-view substrate", () => {
  const base: MapContract = {
    ids: ["a", "b", "c"], titles: ["A", "B", "C"], cores: ["c", "c", "c"], notes: [{}, {}, {}],
    axes: [{ key: "x", name: "X", low: "lo", high: "hi" }, { key: "y", name: "Y", low: "lo", high: "hi" }],
    scores: { x: [0, 50, 100], y: [100, 0, 50] },
    rawScores: { x: [-0.51, 0.02, 0.57], y: [0.44, -0.6, 0.1] },    // true magnitudes (can be negative) behind the ranks
    xy: [[0, 0], [0, 0], [0, 0]], xyz: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    cluster: [0, 0, 1], k: 2, hub: [1, 1, 1], nbr: [[1], [0], [1]],
    clusters: [{ c: 0, n: 2, label: "p" }, { c: 1, n: 1, label: "q" }],
  };
  const back = decodeMap(encodeMap(base));
  expect(back.rawScores).toBeDefined();
  for (const k of ["x", "y"]) for (let i = 0; i < 3; i++) expect(back.rawScores![k][i]).toBeCloseTo(base.rawScores![k][i], 4);
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
    vectors: { data: Float32Array.from(vecs.flat()), dim },
  };
  const back = decodeMap(encodeMap(D));
  expect(back.version).toBe(2);
  expect(back.derivedBy).toEqual(D.derivedBy);                       // provenance record survives exactly
  expect(back.vectors!.dim).toBe(dim);
  expect(back.vectors!.data.length).toBe(n * dim);
  // f16 is lossy in the last bits but must preserve the custom-axis RANKING (the thing it's for)
  let maxErr = 0; for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) maxErr = Math.max(maxErr, Math.abs(vecs[i][j] - back.vectors!.data[i * dim + j]));
  expect(maxErr).toBeLessThan(1e-3);
  const q = vecs[5], dot = (a: number[], b: ArrayLike<number>, o = 0) => a.reduce((s, x, i) => s + x * b[o + i], 0);
  const rank = (row: (i: number) => [ArrayLike<number>, number]) => vecs.map((_, i) => i).sort((a, b) => dot(q, ...row(b)) - dot(q, ...row(a)));
  expect(rank((i) => [back.vectors!.data, i * dim])).toEqual(rank((i) => [vecs[i], 0]));  // ranking identical after f16 round-trip

  // back-compat: a LITE emit (no vectors/derivedBy) decodes with those absent, nothing else lost
  const { vectors, derivedBy, ...lite } = D;
  const backLite = decodeMap(encodeMap(lite as MapContract));
  expect(backLite.vectors).toBeUndefined();
  expect(backLite.derivedBy).toBeUndefined();
  expect(backLite.ids).toEqual(D.ids);
});

test("metaFields: pipeline declares each present field with the right TYPE; only what the corpus carries", () => {
  const axes = [{ key: "a", name: "AxisA", low: "lo", high: "hi" }];
  // a corpus WITH authors/dates/read/tags/citec present
  const rich = buildMetaFields({ axes, authors: ["x", "y"], dates: [1, 2], read: [true, false], tags: [["t"], ["u"]], siteNames: ["s", undefined], urls: ["u1", "u2"], citec: [1, 2], hub: [1, 2] } as any);
  const byKey = Object.fromEntries(rich.map((f) => [f.key, f]));
  expect(byKey.author.type).toBe("categorical");
  expect(byKey.date.type).toBe("temporal");
  expect(byKey.read.type).toBe("boolean");
  expect(byKey.tags.type).toBe("categorical"); expect(byKey.tags.multi).toBe(true);
  expect(byKey.hub.type).toBe("scalar");
  expect(byKey.citec.type).toBe("scalar");
  expect(byKey.length.type).toBe("scalar");            // always derivable from cores
  expect(byKey["axis:a"].type).toBe("scalar");         // each discovered axis is a scalar dimension
  expect(byKey["axis:a"].source).toBe("axis:a");
  // folder: carried column preferred; url-derivation only promised when file:// urls actually exist
  const withCol = buildMetaFields({ axes, hub: [1, 2], folders: ["linux", "osx"] } as any);
  expect(withCol.find((f) => f.key === "folder")?.source).toBe("col:folders");
  const fileUrls = buildMetaFields({ axes, hub: [1, 2], urls: ["file:///a/linux/x.md", "file:///a/osx/y.md"] } as any);
  expect(fileUrls.find((f) => f.key === "folder")?.source).toBe("derived:folder");
  expect(rich.find((f) => f.key === "folder")).toBeUndefined();   // web urls, no folders col → no phantom folder
  // a BARE corpus (no optional metadata) declares only the always-present dims — no phantom fields
  const bare = buildMetaFields({ axes, hub: [1, 2] } as any);
  expect(bare.find((f) => f.key === "author")).toBeUndefined();
  expect(bare.find((f) => f.key === "date")).toBeUndefined();
  expect(bare.map((f) => f.key).sort()).toEqual(["axis:a", "hub", "length"]);
});

test("mapbin v2: metaFields manifest round-trips in the wire format", () => {
  const D: MapContract = {
    version: 2, ids: ["a", "b"], titles: ["A", "B"], cores: ["c", "c"], notes: [{ x: "n" }, { x: "n" }],
    axes: [{ key: "a", name: "AxisA", low: "lo", high: "hi" }], scores: { a: [10, 90] },
    xy: [[0, 0], [1, 1]], xyz: [[0, 0, 0], [1, 1, 0]], cluster: [0, 1], k: 2, di: 0,
    clusters: [{ c: 0, n: 1, label: "p" }, { c: 1, n: 1, label: "q" }], hub: [1, 2], nbr: [[1], [0]],
    dates: [1, 2], read: [true, false], folders: ["linux", undefined],
    metaFields: [
      { key: "folder", label: "folder", type: "categorical", source: "col:folders" },
      { key: "date", label: "date", type: "temporal", source: "col:dates" },
      { key: "read", label: "read", type: "boolean", source: "col:read" },
      { key: "hub", label: "influence", type: "scalar", source: "col:hub" },
    ],
  };
  const back = decodeMap(encodeMap(D));
  expect(back.metaFields).toEqual(D.metaFields);
  expect(back.folders).toEqual(D.folders);   // the carried folder column survives (sparse-restored)
  // a map WITHOUT metaFields decodes with it absent (back-compat)
  const { metaFields, ...lite } = D;
  expect(decodeMap(encodeMap(lite as MapContract)).metaFields).toBeUndefined();
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

// ── the numerical core ────────────────────────────────────────────────────────
// axes/cluster/map/embed had zero coverage: everything above tests the surfaces AROUND the math.
// These pin the math itself — dimension count, ladder shape, rescaling, chunking, caching — with
// synthetic data and injected fakes, so nothing here touches the network or loads an embedder.

import { discoverAxes, mulberry32, truncatedPCA } from "../src/axes.ts";
import { PCA } from "ml-pca";
import { divisiveLevels, findOptimalK, grainLadder } from "../src/cluster.ts";
import { GRAIN_MIN_REGION } from "../src/schema.ts";
import { normPct, knnBrute, knnHNSW, poolEmbed, xyzOverlap, layoutKnn } from "../src/map.ts";

// The 2D↔3D honesty number (eid-ovo7): identical layouts must agree fully; unrelated layouts must not.
test("xyzOverlap: full agreement when the 3D layout IS the 2D layout, near-zero when unrelated", () => {
  const r = mulberry32(11);
  const n = 200;
  const xy = Array.from({ length: n }, () => [r() * 2 - 1, r() * 2 - 1]);
  const same = xy.map((p) => [p[0], p[1], 0]);
  expect(xyzOverlap(xy, same, 8)).toBe(8);                     // same arrangement → all 8 neighbors survive
  const scrambled = xy.map(() => [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]);
  expect(xyzOverlap(xy, scrambled, 8)).toBeLessThan(2);        // unrelated arrangement → chance-level agreement
  // layoutKnn is euclidean in layout space: nearest neighbor of a point on a line is its adjacent point
  const line = Array.from({ length: 10 }, (_, i) => [i, 0]);
  expect(layoutKnn(line, 1).map((r2) => r2[0])).toEqual([1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
import { EmbeddingCache } from "../src/embed.ts";

// A matrix with exactly `k` planted components: every row is a random mix of k orthogonal basis
// directions (large, structured variance) plus per-dimension noise (small, unstructured).
function plantedMatrix(n: number, d: number, k: number, seed = 7, noise = 0.05): number[][] {
  const r = mulberry32(seed);
  const basis = Array.from({ length: k }, (_, c) => Array.from({ length: d }, (_, j) => Math.sin((c + 1) * (j + 1) * 0.7)));
  return Array.from({ length: n }, () => {
    const w = Array.from({ length: k }, () => r() * 2 - 1);
    return Array.from({ length: d }, (_, j) => basis.reduce((s, b, c) => s + w[c] * b[j], 0) + (r() * 2 - 1) * noise);
  });
}
// discoverAxes always calls the LLM labeler; a stub keeps it offline and makes the names predictable.
const axesLLM = { forward: async (_l: any, _i: any) => ({}) };

// The randomized truncated SVD replaced the full one inside discoverAxes. It's an APPROXIMATION, so
// it has to be proven against the exact answer, not eyeballed: same variances, same directions (up to
// sign), same coordinates — on the planted-component fixtures, over the components that carry signal.
const absCos = (a: number[], b: number[]) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return Math.abs(s) / Math.sqrt(na * nb); };

test.each(["gram", "randomized"] as const)("truncatedPCA (%s): matches the exact full SVD on the top components (variance, direction, coordinates)", (method) => {
  for (const [n, d, planted] of [[120, 40, 3], [200, 80, 12]] as number[][]) {
    const X = plantedMatrix(n, d, planted);
    const full = new PCA(X, { center: true });
    const fv = full.getExplainedVariance(), fc = full.getEigenvectors().to2DArray(), fs = full.predict(X).to2DArray();
    const t = truncatedPCA(X, Math.min(30, n, d), { method });
    const ts = t.project(X);
    for (let c = 0; c < planted; c++) {
      expect(Math.abs(t.explainedVariance[c] - fv[c]) / fv[c]).toBeLessThan(1e-3);   // variance spectrum
      const fcv = fc.map((r) => r[c]);
      expect(absCos(t.components[c], fcv)).toBeGreaterThan(0.999);                    // direction, up to sign
      const sign = Math.sign(t.components[c].reduce((s, x, j) => s + x * fcv[j], 0)) || 1;
      const scale = Math.max(...fs.map((r) => Math.abs(r[c])));
      for (let i = 0; i < n; i++) expect(Math.abs(ts[i][c] * sign - fs[i][c]) / scale).toBeLessThan(1e-3); // coordinates
    }
    // explained variances are FRACTIONS of the total, in descending order, summing to <= 1
    expect(t.explainedVariance.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
    for (let c = 1; c < t.explainedVariance.length; c++) expect(t.explainedVariance[c]).toBeLessThanOrEqual(t.explainedVariance[c - 1] + 1e-12);
  }
});

test.each(["gram", "randomized"] as const)("truncatedPCA (%s): DETERMINISTIC — identical input gives byte-identical output", (method) => {
  const X = plantedMatrix(90, 25, 4, 3);
  const a = truncatedPCA(X, 20, { seed: 42, method }), b = truncatedPCA(X, 20, { seed: 42, method });
  expect(b.components).toEqual(a.components);
  expect(b.explainedVariance).toEqual(a.explainedVariance);
  expect(b.project(X)).toEqual(a.project(X));
});

// The two routes are two implementations of the SAME decomposition — they must agree with each other,
// not just each with ml-pca, or the d > 2048 fallback would silently ship different geometry.
test("truncatedPCA: the gram and randomized routes agree on the top components", () => {
  const X = plantedMatrix(150, 60, 8, 5);
  const g = truncatedPCA(X, 20, { method: "gram" }), r = truncatedPCA(X, 20, { method: "randomized" });
  for (let c = 0; c < 8; c++) {
    expect(Math.abs(g.explainedVariance[c] - r.explainedVariance[c]) / g.explainedVariance[c]).toBeLessThan(1e-3);
    expect(absCos(g.components[c], r.components[c])).toBeGreaterThan(0.999);
  }
});

test("discoverAxes: parallel analysis finds the PLANTED dimensionality, not the ambient one", async () => {
  const n = 120, d = 40, planted = 3;
  const X = plantedMatrix(n, d, planted);
  const titles = Array.from({ length: n }, (_, i) => "doc " + i);
  const { realDims, axes, projections, all } = await discoverAxes(X, titles, { llm: {}, topN: 16 } as any);
  // the noise floor must cut the 40 ambient dims down to roughly the 3 real ones (never the full 40)
  expect(realDims).toBeGreaterThanOrEqual(planted);
  expect(realDims).toBeLessThan(10);
  // axes are capped by the honest dim count — we never surface more axes than the data supports
  expect(axes.length).toBe(Math.min(16, Math.max(realDims, 2)));
  expect(all.length).toBe(axes.length);
  expect(axes.map((a) => a.pc)).toEqual(axes.map((_, i) => i + 1)); // PCs in order, 1-indexed
  // projections: one row per doc, scores for every component, and PC1 explains the most variance
  expect(projections.length).toBe(n);
  expect(projections[0].length).toBeGreaterThanOrEqual(realDims);
  for (let i = 1; i < axes.length; i++) expect(axes[i].var).toBeLessThanOrEqual(axes[i - 1].var);
});

test("discoverAxes: DETERMINISTIC across runs — same corpus + config, identical geometry", async () => {
  const X = plantedMatrix(80, 30, 4, 11);
  const titles = X.map((_, i) => "t" + i);
  const a = await discoverAxes(X, titles, { llm: {} } as any);
  const b = await discoverAxes(X, titles, { llm: {} } as any);
  expect(b.realDims).toBe(a.realDims);                            // the seeded noise floor no longer wobbles
  expect(b.axes.map((x) => x.var)).toEqual(a.axes.map((x) => x.var));
  expect(b.projections).toEqual(a.projections);                   // the coordinates themselves are identical
  // an explicit different seed exercises the seam (the shuffle really is driven by it)
  expect(typeof (await discoverAxes(X, titles, { llm: {}, seed: 999 } as any)).realDims).toBe("number");
});

test("mulberry32: seeded, reproducible, and uniform-ish in [0,1)", () => {
  const a = Array.from({ length: 200 }, mulberry32(5));
  const b = Array.from({ length: 200 }, mulberry32(5));
  expect(a).toEqual(b);
  expect(a).not.toEqual(Array.from({ length: 200 }, mulberry32(6)));
  expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...a)).toBeLessThan(1);
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  expect(Math.abs(mean - 0.5)).toBeLessThan(0.08);
});

// three well-separated blobs on the unit sphere — divisive splitting should find them and keep going
function blobs(perBlob: number, k: number, d = 12, seed = 3): number[][] {
  const r = mulberry32(seed), out: number[][] = [];
  for (let c = 0; c < k; c++) for (let i = 0; i < perBlob; i++) {
    const v = Array.from({ length: d }, (_, j) => (j % k === c ? 1 : 0) + (r() * 2 - 1) * 0.08);
    const n = Math.hypot(...v); out.push(v.map((x) => x / n));
  }
  return out;
}

test("divisiveLevels: nested ladder — counts ascend, assignments PARTITION the set, ladder is the GENERATED one", () => {
  const X = blobs(60, 3);                                   // 180 points
  const { levels, counts } = divisiveLevels(X);
  expect(counts.length).toBe(levels.length);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));  // ladder ascends
  // the ladder is exactly the generated geometric one for this corpus's emergent kmax — no hand list
  expect(counts).toEqual(grainLadder(counts[counts.length - 1]));
  for (let l = 0; l < levels.length; l++) {
    const a = levels[l];
    expect(a.length).toBe(X.length);                          // every point assigned exactly once
    expect(a.every((c) => Number.isInteger(c) && c >= 0 && c < counts[l])).toBe(true);
    expect(new Set(a).size).toBe(counts[l]);                  // no empty cluster — labels are dense 0..k-1
  }
  // NESTED: a finer level never merges two points that a coarser level separated
  for (let l = 1; l < levels.length; l++)
    for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++)
      if (levels[l][i] === levels[l][j]) expect(levels[l - 1][i]).toBe(levels[l - 1][j]);
});

test("divisiveLevels: the GRAIN_MIN_REGION floor stops the split — kmax emerges, no shattering into singletons", () => {
  const X = blobs(20, 3);                                    // 60 points, floor 25
  const { levels, counts } = divisiveLevels(X);
  const kmax = counts[counts.length - 1];
  const last = levels[levels.length - 1];
  const sizes = Array.from({ length: kmax }, (_, c) => last.filter((x) => x === c).length);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(X.length);
  // a group at or below the floor is never divided, so no more than ceil(n / (floor/2))-ish groups —
  // and concretely: every split's PARENT had > GRAIN_MIN_REGION members, so kmax < n / (GRAIN_MIN_REGION / 2)
  expect(kmax).toBeLessThan(X.length / (GRAIN_MIN_REGION / 2));
  expect(Math.min(...sizes)).toBeGreaterThan(0);
});

test("grainLadder: geometric ×GRAIN_RATIO stops from 2 to kmax inclusive, strictly ascending", () => {
  for (const kmax of [1, 2, 3, 21, 101, 1045]) {
    const ks = grainLadder(kmax);
    expect(ks[ks.length - 1]).toBe(Math.max(1, kmax));
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThan(ks[i - 1]);
    if (kmax >= 2) expect(ks[0]).toBe(2);
  }
  expect(grainLadder(101)).toEqual([2, 3, 5, 8, 12, 18, 27, 41, 62, 93, 101]);
});

test("divisiveLevels + findOptimalK: deterministic — the same matrix yields the same ladder every run", () => {
  const X = blobs(40, 3, 12, 9);
  const a = divisiveLevels(X);
  const b = divisiveLevels(X);
  expect(b.counts).toEqual(a.counts);
  expect(b.levels).toEqual(a.levels);
  expect(findOptimalK(X)).toBe(findOptimalK(X));
});

test("normPct: rescales each dim by its 2-98 percentile band, robust to a far outlier", () => {
  const col = Array.from({ length: 100 }, (_, i) => i);       // 0..99
  const pts = col.map((v) => [v, 100000]);                    // dim1 constant → guard against /0
  pts.push([100000, 100000]);                                 // one wild outlier in dim0
  const out = normPct(pts, 2);
  expect(out.length).toBe(pts.length);
  // the bulk lands inside roughly [-1,1]; the outlier is allowed to exceed it (that's the honest part)
  const bulk = out.slice(0, 100).map((r) => r[0]);
  expect(Math.min(...bulk)).toBeGreaterThan(-1.3);
  expect(Math.max(...bulk)).toBeLessThan(1.3);
  expect(out[out.length - 1][0]).toBeGreaterThan(1.3);        // outlier not clipped, just off-band
  expect(out.every((r) => Number.isFinite(r[1]))).toBe(true); // constant dim → no NaN/Infinity
  const mid = bulk[49];
  expect(Math.abs(mid)).toBeLessThan(0.2);                    // the median sits near zero (band is centered)
});

test("kNN: the HNSW index agrees with exact brute force on a synthetic set", async () => {
  const X = blobs(30, 3, 16, 21);                             // 90 unit vectors, 3 tight blobs
  const K = 5;
  const brute = knnBrute(X, K), approx = await knnHNSW(X, K);
  expect(approx.length).toBe(brute.length);
  let overlap = 0;
  for (let i = 0; i < X.length; i++) {
    expect(brute[i].length).toBe(K);
    expect(brute[i]).not.toContain(i);                        // never your own neighbor
    expect(approx[i]).not.toContain(i);
    overlap += approx[i].filter((j) => brute[i].includes(j)).length;
  }
  expect(overlap / (X.length * K)).toBeGreaterThan(0.9);      // approximate index recovers the exact answer
});

// a fake embedder: no model, no network — one deterministic vector per chunk, so we can COUNT chunks
const fakeEmbedder = (seen: { id: string; text: string }[][]) =>
  async (items: { id: string; text: string }[], opts: { cache?: EmbeddingCache }) => {
    seen.push(items);
    return items.map((it) => { const v = [it.text.split(/\s+/).filter(Boolean).length, it.text.length, 1]; opts.cache?.set(it.id, v); return v; });
  };

test("poolEmbed: chunks long text, mean-pools back per doc, and dedupes identical chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-pool-"));
  const seen: { id: string; text: string }[][] = [];
  const long = Array.from({ length: 25 }, (_, i) => "w" + i).join(" ");   // 25 words
  const out = await poolEmbed([long, "short text", long], dir, { embed: fakeEmbedder(seen), chunkWords: 10, maxChunks: 50 });
  rmSync(dir, { recursive: true, force: true });
  expect(out.length).toBe(3);
  // 25 words at 10/chunk = 3 chunks; identical docs 0 and 2 hash to the SAME chunk ids → deduped
  const ids = new Set(seen[0].map((i) => i.id));
  expect(seen[0].length).toBe(3 + 1 + 3);                                  // spans are per-doc, ids repeat
  expect(ids.size).toBe(4);                                                // 3 unique chunks + the short doc
  expect(out[0]).toEqual(out[2]);                                          // identical text → identical vector
  expect(out[0][0]).toBeCloseTo(25 / 3, 6);                                // mean-pooled word count across chunks
  expect(out[1][0]).toBe(2);                                               // "short text" is one 2-word chunk
});

test("poolEmbed: maxChunks subsamples by STRIDE (spans the doc) instead of truncating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-pool2-"));
  const seen: { id: string; text: string }[][] = [];
  const words = Array.from({ length: 100 }, (_, i) => "w" + i);
  await poolEmbed([words.join(" ")], dir, { embed: fakeEmbedder(seen), chunkWords: 1, maxChunks: 5 });
  rmSync(dir, { recursive: true, force: true });
  const texts = seen[0].map((i) => i.text);
  expect(texts.length).toBe(5);                                            // capped
  expect(texts[0]).toBe("w0");
  expect(texts[texts.length - 1]).toBe("w80");                             // stride 20 — reaches deep into the doc
  expect(texts).toEqual(["w0", "w20", "w40", "w60", "w80"]);               // evenly spread, not the first 5
});

test("poolEmbed: empty text still yields a vector (never drops a doc from the geometry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-pool3-"));
  const out = await poolEmbed(["", "   "], dir, { embed: fakeEmbedder([]), chunkWords: 10 });
  rmSync(dir, { recursive: true, force: true });
  expect(out.length).toBe(2);
  expect(out.every((v) => v.length === 3 && v.every(Number.isFinite))).toBe(true);
});

test("EmbeddingCache: miss then hit, and the hit survives a persistence round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-embcache-"));
  const c1 = new EmbeddingCache(dir, "test/model");
  await c1.load();
  expect(c1.get("a")).toBeUndefined();                       // cold miss
  c1.set("a", [1, 2, 3]);
  expect(c1.get("a")).toEqual([1, 2, 3]);                    // warm hit in-process
  await c1.save();
  const c2 = new EmbeddingCache(dir, "test/model");          // a fresh "process"
  await c2.load();
  expect(c2.get("a")).toEqual([1, 2, 3]);                    // persisted to disk
  const other = new EmbeddingCache(dir, "other/model");      // a DIFFERENT model must not read those vectors
  await other.load();
  expect(other.get("a")).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("poolEmbed: a second pass over the same texts is served entirely from the on-disk cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-pool4-"));
  const seen: { id: string; text: string }[][] = [];
  const embed = fakeEmbedder(seen);
  const texts = ["alpha beta gamma", "delta epsilon"];
  const a = await poolEmbed(texts, dir, { embed, chunkWords: 10 });
  const b = await poolEmbed(texts, dir, { embed, chunkWords: 10 });       // reload from disk
  rmSync(dir, { recursive: true, force: true });
  expect(b).toEqual(a);
  expect(seen[1].every((it) => seen[0].some((p) => p.id === it.id))).toBe(true); // same content-addressed ids
});

test("cachePath/cacheRoot: every cache lands under one root, and legacy CWD files migrate by rename", async () => {
  // cachePath resolves relative to CWD, so run this inside a throwaway dir seeded with the OLD layout
  const dir = mkdtempSync(join(tmpdir(), "eido-cwd-"));
  const prevCwd = process.cwd(), prevEnv = process.env.EIDOSCOPE_CACHE_DIR;
  process.chdir(dir);
  delete process.env.EIDOSCOPE_CACHE_DIR;
  try {
    writeFileSync(join(dir, "card-cache.jsonl"), '{"k":"v"}\n');        // an expensive pre-existing cache
    mkdirSync(join(dir, "cache-eidoscope-cards"), { recursive: true });
    writeFileSync(join(dir, "cache-eidoscope-cards", "m.json"), "{}");
    const { CFG, cachePath, cacheRoot } = await import("../src/config.ts");
    expect(cacheRoot()).toBe(CFG.cacheDir);
    expect(cachePath("s2-cache.json")).toBe(join(CFG.cacheDir, "s2-cache.json"));
    cachePath("cache-eidoscope-cards");
    // migrated, not duplicated: the old paths are gone and the content moved intact
    expect(existsSync(join(dir, "card-cache.jsonl"))).toBe(false);
    expect(readFileSync(join(dir, CFG.cacheDir, "card-cache.jsonl"), "utf8")).toBe('{"k":"v"}\n');
    expect(existsSync(join(dir, "cache-eidoscope-cards"))).toBe(false); // directories migrate too
    expect(existsSync(join(dir, CFG.cacheDir, "cache-eidoscope-cards", "m.json"))).toBe(true);
    // idempotent: a second run neither throws nor clobbers the migrated cache
    cachePath("card-cache.jsonl");
    expect(readFileSync(join(dir, CFG.cacheDir, "card-cache.jsonl"), "utf8")).toBe('{"k":"v"}\n');
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.EIDOSCOPE_CACHE_DIR; else process.env.EIDOSCOPE_CACHE_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFolder: exact content duplicates collapse to one doc (exporter twins)", () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-dupe-"));
  const body = "A document long enough to clear the default minimum character floor. ".repeat(5);
  writeFileSync(join(dir, "one.md"), `# Same Title\n\n${body}`);
  writeFileSync(join(dir, "two.md"), `# Same Title\n\n${body}`);           // exact twin, different file
  writeFileSync(join(dir, "three.md"), `# Same Title\n\n${body} But this one differs.`);  // same title, different body — kept
  const docs = loadFolder(dir);
  expect(docs.length).toBe(2);
  expect(docs.filter((d) => d.title === "Same Title").length).toBe(2);
});

// ── REAL-CORPUS CONTRACT ────────────────────────────────────────────────────────────────────────────
// The synthetic corpus in e2e/synth.ts makes assertions sharp (known ground truth) but it is OURS — it
// can't catch what real text, real LLM cards and real metadata do to the contract. This 24-document
// example map is a genuine pipeline output (real cards, real discovered axes), committed at 36KB so CI
// exercises a real corpus on every push instead of only our own fixture.
test("real corpus fixture: a genuine .eido decodes with every invariant the viewer relies on", () => {
  const D = decodeMap(readFileSync(join(import.meta.dir, "fixtures", "example.eido")));
  const n = D.ids.length;
  expect(n).toBeGreaterThan(20);
  // every node-indexed array is aligned — the exact class of bug that shipped misaligned scores (d2dc949)
  for (const [name, arr] of [["titles", D.titles], ["cores", D.cores], ["notes", D.notes], ["xy", D.xy], ["xyz", D.xyz], ["cluster", D.cluster], ["hub", D.hub], ["nbr", D.nbr]] as [string, unknown[]][])
    expect(`${name}:${arr.length}`).toBe(`${name}:${n}`);
  for (const a of D.axes) expect(`${a.key}:${D.scores[a.key]?.length}`).toBe(`${a.key}:${n}`);
  // the cards are real prose, not placeholders, and the axes were named by the model
  expect(D.cores.every((c) => c.length > 40)).toBe(true);
  expect(D.axes.every((a) => a.name && a.low && a.high)).toBe(true);
  // honest-axis substrate present (raw projections, not just ranks) — what the honest⇄rank toggle needs
  expect(D.rawScores ? Object.keys(D.rawScores).length : 0).toBe(D.axes.length);
  // provenance the "about this map" surface reads
  expect(D.derivedBy?.embedder?.dim).toBeGreaterThan(0);
});

// REPORT.md honesty: the 2% main/minor split and the printed percentages must agree — a 1.96%
// minor axis must never render as "2.0%" under a header that says "each under 2%".
test("buildReport: a minor axis near the 2% line never rounds up across it", async () => {
  const { buildReport } = await import("../src/report.ts");
  const D = synthMap();
  D.axes = [
    { key: "a", name: "AxisA", low: "LowA", high: "HighA", variance: 0.03 },
    { key: "b", name: "AxisB", low: "LowB", high: "HighB", variance: 0.0196, weak: true },
  ];
  const md = buildReport(D, "T");
  expect(md).toContain("1.96% of the variation");
  expect(md).not.toContain("2.0% of the variation");
  // and the usage line lands in the footer when given
  expect(buildReport(D, "T", { usage: "LLM usage: 12 tokens" })).toContain("LLM usage: 12 tokens");
});
