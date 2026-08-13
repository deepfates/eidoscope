// INGEST PARITY (eid-bacg): the in-page engine and the node pipeline are the SAME stages behind two
// host bindings — prove it numerically. Both faces run the 24-doc example corpus with the same
// deterministic fake embedder and mock LLM signatures (no network, no model download); the resulting
// maps must agree on axes, scores and geometry to float tolerance (they share seeds, so exactly).
// Plus the key gating of the page's IngestRun, which needs no models to fire.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadFolder } from "../src/corpus.ts";
import { run } from "../src/pipeline.ts";
import { buildMap } from "../src/engine.ts";
import { poolEmbedWith } from "../src/geometry.ts";
import type { Embedder } from "../src/map.ts";
import { IngestRun } from "../viewer/src/run.ts";
import { defaultCompute } from "../viewer/src/compute";

// Deterministic fake embedder: a seeded 32-dim vector from each chunk's content hash. Same text in,
// same vector out, on both faces — so any divergence downstream is REAL stage divergence, not noise.
const fakeVec = (text: string): number[] => {
  let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  for (let j = 0; j < 32; j++) { h = (h * 1103515245 + 12345) >>> 0; out.push(((h / 0xffffffff) - 0.5) * 2); }
  return out;
};
const nodeEmbedder: Embedder = async (items) => items.map((it) => fakeVec(it.text));
const pageEmbed = async (items: { id: string; text: string }[]) => items.map((it) => fakeVec(it.text));

const cardSig = { forward: async (_llm: any, inp: any) => ({
  restatement: "Restated: " + inp.documentTitle,
  axisPlacements: (inp.corpusAxes as string).split("\n").map((_l: string, i: number) => `placement ${i + 1} for ${inp.documentTitle}`),
}) };
const regionSig = { forward: async (_llm: any, inp: any) => ({ regionLabel: "R:" + (inp.distinctiveTerms as string).split(",")[0].trim(), regionBlurb: "b" }) };

const EXAMPLE = resolve(import.meta.dir, "..", "example");

test("in-page engine ≡ node pipeline on the 24-doc example corpus (axes, scores, geometry)", async () => {
  const docs = loadFolder(EXAMPLE);
  expect(docs.length).toBe(24);
  const embeddings = await poolEmbedWith(docs.map((d) => (d.title ? d.title + ". " : "") + d.body), pageEmbed);

  // the NODE face: pipeline.run with the same injected seams (fake embedder, mock sigs, no disk cache)
  const outDir = mkdtempSync(join(tmpdir(), "eido-parity-"));
  const nodeD = await run(docs, embeddings, { name: "example", llm: {}, cardSig, regionSig, embedder: nodeEmbedder, cacheDir: null, out: outDir });

  // the PAGE face: engine.buildMap exactly as viewer/src/ingest.ts calls it (no hnsw injection,
  // poolEmbedWith over the raw embedder, session-memory caches)
  const pageD = (await buildMap(docs, embeddings, {
    llm: {}, cardSig, regionSig,
    embedCardTexts: (texts) => poolEmbedWith(texts, pageEmbed),
    concurrency: 8, name: "example",
    cardModel: "test-model", embedderId: "test-embedder",
  })).D;

  // identity + axes agree exactly
  expect(pageD.ids).toEqual(nodeD.ids);
  expect(pageD.axes.map((a) => a.key)).toEqual(nodeD.axes.map((a) => a.key));
  expect(pageD.axes.map((a) => a.variance)).toEqual(nodeD.axes.map((a) => a.variance));
  // scores: the deterministic PCA projections, rank-normalized — must be identical
  for (const a of nodeD.axes) {
    expect(pageD.scores[a.key]).toEqual(nodeD.scores[a.key]);
    const pr = pageD.rawScores![a.key], nr = nodeD.rawScores![a.key];
    pr.forEach((v, i) => expect(Math.abs(v - nr[i])).toBeLessThan(1e-9));
  }
  // geometry: same seeds, same code path (n=24 < HNSW_MIN so neither face uses hnsw) → same layout
  pageD.xy.forEach((p, i) => { expect(Math.abs(p[0] - nodeD.xy[i][0])).toBeLessThan(1e-6); expect(Math.abs(p[1] - nodeD.xy[i][1])).toBeLessThan(1e-6); });
  expect(pageD.cluster).toEqual(nodeD.cluster);
  expect(pageD.k).toBe(nodeD.k);
  expect(pageD.counts).toEqual(nodeD.counts);
  expect(pageD.levelLabels).toEqual(nodeD.levelLabels);
  expect(pageD.nbr).toEqual(nodeD.nbr);
  expect(pageD.hub).toEqual(nodeD.hub);
  // the carried substrate: same card vectors either way
  expect(pageD.vectors!.dim).toBe(nodeD.vectors!.dim);
  expect([...pageD.vectors!.data]).toEqual([...nodeD.vectors!.data]);
  // both declare the honest basis
  expect(pageD.derivedBy!.geometryBasis).toBe("card");
  expect(nodeD.derivedBy!.geometryBasis).toBe("card");
  rmSync(outDir, { recursive: true, force: true });
}, 60000);

// ── the page run's honesty gate (no models involved — fires before any embedding). The old doc-count
// envelope refusal is DEAD (the engine runs in a worker; any size runs, narrated with measured
// estimates) — an empty corpus is still a plain, named error.
test("IngestRun: an empty folder is a plain, named error", async () => {
  const run2 = new IngestRun([{ path: "a/nope.png", name: "nope.png", text: "x" }], "empty", () => {});
  expect(run2.start({ ...defaultCompute(), key: "sk-test" })).rejects.toThrow(/no documents found/);
});
