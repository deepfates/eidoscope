// The export surface (eid-sh90). Every outbound artefact had ZERO unit coverage until now — it was
// buried in App.svelte, so testing it meant mounting a component, so nobody did. It is exercised end to
// end by the viewer e2e, but nothing pinned the filenames, the packaging, or the empty cases.
// eid-ncrq is about to add separable-parts export on top of this, which is the other reason to pin it now.
import { test, expect } from "bun:test";
import { unzipSync, strFromU8, gunzipSync } from "fflate";
import { exportBase, eidoBytes, htmlArtifact, vaultArtifact, deckArtifact, partsArtifact, selectionArtifact, appShell, portableSource } from "../viewer/src/exports";
import { decodeContainer } from "../src/eido-container";
import type { MapContract } from "../src/schema";
import { synthMap } from "../e2e/synth";

// Use the repo's OWN synthetic map (e2e/synth.ts) rather than a hand-rolled object: a partial contract
// only proves the encoder rejects partial contracts, which is not what these tests are about.
const mapOf = (): MapContract => synthMap();

test("the base name drops a .eido extension and survives one that has none", () => {
  expect(exportBase("readwise.eido")).toBe("readwise");
  expect(exportBase("readwise.EIDO")).toBe("readwise");
  expect(exportBase("pitchfork")).toBe("pitchfork");
  expect(exportBase("")).toBe("eidoscope");   // never produce a nameless file
  expect(exportBase("my.map.eido")).toBe("my.map");   // only the trailing extension goes
});

// Save and the single-file export must agree with the pipeline's own codec, or a saved file would not
// reopen. This is the one that would actually lose someone's work if it broke.
test("the saved bytes are gzipped container bytes the shared decoder reads back", () => {
  const D = mapOf();
  const round = decodeContainer(gunzipSync(eidoBytes(D)));
  expect(round.ids).toEqual(D.ids);
  expect(round.titles).toEqual(D.titles);
});

test("the vault is a zip of markdown cards plus a manifest, named from the document", () => {
  const a = vaultArtifact(mapOf(), "readwise");
  expect(a.name).toBe("readwise-vault.zip");
  expect(a.type).toBe("application/zip");
  const D = mapOf();
  const files = unzipSync(a.data as Uint8Array);
  const names = Object.keys(files);
  expect(names.filter((n) => n.endsWith(".md")).length).toBeGreaterThanOrEqual(D.ids.length);   // one per card
  expect(names.length).toBeGreaterThan(D.ids.length);                                          // …plus a manifest
  // some card file carries the first card's restatement — the vault is fed from the cards
  const all = names.map((n) => strFromU8(files[n])).join("\n");
  expect(all).toContain(D.cores[0]);
});

test("the deck export is one JSON object per line, one line per card", () => {
  const a = deckArtifact(mapOf(), "readwise");
  expect(a.name).toBe("readwise-deck.jsonl");
  const D = mapOf();
  const lines = String(a.data).trim().split("\n");
  expect(lines).toHaveLength(D.ids.length);          // one line per card, no header, no trailer
  expect(JSON.parse(lines[0]).id).toBe(D.ids[0]);
  for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
});

test("a selection export carries ids, titles and urls, and counts itself in the filename", () => {
  const D = mapOf();
  const a = selectionArtifact(D, "readwise", [0, 2])!;
  expect(a.name).toBe("readwise-selection-2.json");
  const p = JSON.parse(String(a.data));
  expect(p.ids).toEqual([D.ids[0], D.ids[2]]);              // the held INDICES map to their ids, in order
  expect(p.titles).toEqual([D.titles[0], D.titles[2]]);
  expect(p.urls).toHaveLength(2);                          // a url may be absent; the slot is still carried
});

// An empty held set is not an error and not an empty file — it is nothing to export. The component used
// to guard this inline; the guard moved with the function rather than being dropped.
test("an empty selection produces no artefact at all", () => {
  expect(selectionArtifact(mapOf(), "readwise", [])).toBeNull();
});

test("the single-file export bakes the document into the given shell", () => {
  const a = htmlArtifact(mapOf(), "readwise", "<!doctype html><head></head><body></body>");
  expect(a.name).toBe("readwise.html");
  expect(a.type).toBe("text/html");
  expect(String(a.data).length).toBeGreaterThan(200);   // the payload is actually in there
});

// The shell comes from the served page; when that fetch fails (file://) it falls back to the live
// document. Both branches matter — the offline e2e depends on the fallback.
test("the app shell falls back to the live document when the page can't be fetched", async () => {
  (globalThis as any).document = { documentElement: { outerHTML: "<html>live</html>" } };
  const failing = (async () => { throw new Error("file:// has no fetch"); }) as unknown as typeof fetch;
  expect(await appShell(failing, "/index.html")).toContain("live");
  const serving = (async () => ({ ok: true, text: async () => "<html>served</html>" })) as unknown as typeof fetch;
  expect(await appShell(serving, "/index.html")).toContain("served");
  delete (globalThis as any).document;
});

// ── PROVENANCE THAT TRAVELS (Hac-3r74) ───────────────────────────────────────────────────────────────
// Every published map carried the builder's home directory, because the CLI recorded an absolute path
// and the about panel printed it. Files already in the world still carry it, so display and re-emit both
// go through portableSource — which means it is worth pinning what it does and does NOT touch.
test("an absolute source is reduced to the corpus folder's own name", () => {
  expect(portableSource("/Users/someone/Hacking/eidoscope-testdata/pitchfork")).toBe("pitchfork");
  expect(portableSource("/Users/someone/data/openrouter-model-cards/current/documents")).toBe("documents");
  expect(portableSource("/Users/someone/corpus/")).toBe("corpus");        // a trailing slash is not a nameless folder
  expect(portableSource("~/notes/reading")).toBe("reading");
  expect(portableSource("C:\\Users\\someone\\corpus")).toBe("corpus");    // the other kind of machine leaks too
});

// The point is NOT to shorten every source — the connectors write descriptions worth reading whole, and
// truncating those to one word would destroy real provenance to fix a problem they never had.
test("a portable description is left exactly as it was written", () => {
  const hf = 'huggingface:wikimedia/wikipedia (20231101.en/train) · column "text" · 400 rows';
  expect(portableSource(hf)).toBe(hf);
  expect(portableSource("folder (in-page ingest) · 285 files")).toBe("folder (in-page ingest) · 285 files");
  expect(portableSource('descend of "readwise" — 30 of 1385 cards')).toBe('descend of "readwise" — 30 of 1385 cards');
  expect(portableSource(undefined)).toBeUndefined();   // absent stays absent, never the string "undefined"
});

test("a vault exported from an old map does not carry the path onward", () => {
  const D = { ...mapOf(), provenance: { title: "x", source: "/Users/someone/Hacking/readwise/markdown-export" } } as MapContract;
  const files = unzipSync(vaultArtifact(D, "x").data as Uint8Array);
  expect(JSON.parse(strFromU8(files["eidoscope-vault.json"])).source).toBe("markdown-export");
  const parts = unzipSync(partsArtifact(D, "x").data as Uint8Array);
  expect(JSON.parse(strFromU8(parts["manifest.json"])).provenance.source).toBe("markdown-export");
  // …and the rest of the provenance is untouched — this sanitizes one field, it does not rewrite the record
  expect(JSON.parse(strFromU8(parts["manifest.json"])).provenance.title).toBe("x");
});

// ── SEPARABLE PARTS (eid-ncrq) ───────────────────────────────────────────────────────────────────────
// deepfates asked for the three things to come apart: "the embeddings are one thing that we're storing,
// and the metadata about how to display them is another, and the LLM generated structure/text is another
// one. And so we should be able to export things separately."
test("the parts export splits into cards, vectors, geometry and a manifest", () => {
  const D = mapOf();
  const a = partsArtifact(D, "readwise");
  expect(a.name).toBe("readwise-parts.zip");
  const files = unzipSync(a.data as Uint8Array);
  expect(Object.keys(files).sort()).toContain("cards.jsonl");
  expect(Object.keys(files).sort()).toContain("geometry.json");
  expect(Object.keys(files).sort()).toContain("manifest.json");
});

test("the cards part is source truth: one line per card, joinable by id", () => {
  const D = mapOf();
  const files = unzipSync(partsArtifact(D, "x").data as Uint8Array);
  const lines = strFromU8(files["cards.jsonl"]).trim().split("\n");
  expect(lines).toHaveLength(D.ids.length);
  expect(lines.map((l) => JSON.parse(l).id)).toEqual(D.ids);   // same order as every other part
});

test("the geometry part carries ids, so its arrays can be rejoined without trusting order", () => {
  const D = mapOf();
  const g = JSON.parse(strFromU8(unzipSync(partsArtifact(D, "x").data as Uint8Array)["geometry.json"]));
  expect(g.ids).toEqual(D.ids);
  expect(g.xy).toHaveLength(D.ids.length);
  expect(g.axes).toEqual(D.axes);
});

// The vectors are written as a raw f32 buffer precisely so numpy/torch can read them with no bespoke
// decoder. If the byte length ever stops matching n × dim × 4, that promise is broken.
test("the vectors part is a raw f32 buffer whose shape the manifest states", () => {
  const D = mapOf();
  const files = unzipSync(partsArtifact(D, "x").data as Uint8Array);
  const man = JSON.parse(strFromU8(files["manifest.json"]));
  expect(D.vectors?.data?.length).toBeGreaterThan(0);   // the fixture must exercise this branch, or the test proves nothing
  expect(files["vectors.f32"].byteLength).toBe(D.ids.length * D.vectors!.dim * 4);
  expect(man.files["vectors.f32"]).toContain(String(D.vectors!.dim));
  // and it round-trips as real numbers, not garbage
  const back = new Float32Array(files["vectors.f32"].buffer, files["vectors.f32"].byteOffset, D.ids.length * D.vectors!.dim);
  expect(Number.isFinite(back[0])).toBe(true);
});

test("the manifest describes every file it shipped, and none it didn't", () => {
  const D = mapOf();
  const files = unzipSync(partsArtifact(D, "x").data as Uint8Array);
  const man = JSON.parse(strFromU8(files["manifest.json"]));
  expect(man.format).toBe("eidoscope-parts/1");
  expect(man.cards).toBe(D.ids.length);
  for (const named of Object.keys(man.files)) expect(files[named]).toBeDefined();
  // views.json only exists when there IS work — an empty one would imply work that isn't there.
  // The fixture carries no views, so assert that side here and the other side below; testing only the
  // branch your fixture happens to take is how a conditional assertion quietly stops meaning anything.
  expect(D.views?.length ?? 0).toBe(0);
  expect("views.json" in man.files).toBe(false);
  expect(files["views.json"]).toBeUndefined();
});

test("…and a map that HAS saved work ships views.json, described in the manifest", () => {
  const D = { ...mapOf(), views: [{ name: "the good bit", created: 0, state: {} }] } as unknown as MapContract;
  const files = unzipSync(partsArtifact(D, "x").data as Uint8Array);
  expect(files["views.json"]).toBeDefined();
  expect(JSON.parse(strFromU8(files["views.json"]))[0].name).toBe("the good bit");
  expect(JSON.parse(strFromU8(files["manifest.json"])).files["views.json"]).toContain("1 saved view");
});
