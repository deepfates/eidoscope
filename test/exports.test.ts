// The export surface (eid-sh90). Every outbound artefact had ZERO unit coverage until now — it was
// buried in App.svelte, so testing it meant mounting a component, so nobody did. It is exercised end to
// end by the viewer e2e, but nothing pinned the filenames, the packaging, or the empty cases.
// eid-ncrq is about to add separable-parts export on top of this, which is the other reason to pin it now.
import { test, expect } from "bun:test";
import { unzipSync, strFromU8, gunzipSync } from "fflate";
import { exportBase, eidoBytes, htmlArtifact, vaultArtifact, deckArtifact, selectionArtifact, appShell } from "../viewer/src/exports";
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
