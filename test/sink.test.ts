// The SINK seam (src/sink.ts), proven by its round trip: a map exported as a markdown vault is itself
// a valid corpus — folderSource re-ingests it with nothing lost. That closed loop is what makes the
// vault a curation surface (edit/cull in any markdown tool, re-map) rather than a dead export.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthMap } from "../e2e/synth.ts";
import { vaultSink, eidoSink, slugify } from "../src/sink.ts";
import { folderSource } from "../src/corpus.ts";
import { decodeMap } from "../src/mapbin.ts";

describe("vault sink", () => {
  test("export → re-ingest round trip: every card survives with its identity", async () => {
    const D = synthMap();
    const dir = mkdtempSync(join(tmpdir(), "eido-vault-"));
    try {
      const files = vaultSink.emit(D, dir);
      expect(files.length).toBe(D.ids.length);

      // one file, spot-checked: frontmatter carries the map's judgment (id, axis scores, region, url)
      const first = readFileSync(files[0], "utf8");
      expect(first).toContain(`id: "${D.ids[0]}"`);
      expect(first).toContain("axes:");
      expect(first).toContain(`  a: ${D.scores.a[0]}`);
      expect(first).toContain("region:");
      expect(first).toContain(D.cores[0].slice(0, 10));

      // the loop: the vault is a corpus. minChars 0 because cards are legitimately short restatements.
      const { docs } = await folderSource(dir, { minChars: 0 }).load();
      expect(docs.length).toBe(D.ids.length);
      expect(new Set(docs.map((d) => d.id))).toEqual(new Set(D.ids));
      const byId = new Map(docs.map((d) => [d.id, d]));
      expect(byId.get(D.ids[3])!.title).toBe(D.titles[3]);
      expect(byId.get(D.ids[3])!.url).toBe(D.urls![3]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("id collisions after filename sanitization stay distinct files", () => {
    const D = synthMap();
    D.ids[1] = "we/ird"; D.ids[2] = "we ird";   // both sanitize to "we_ird"
    const dir = mkdtempSync(join(tmpdir(), "eido-vault-"));
    try {
      const files = vaultSink.emit(D, dir);
      expect(new Set(files).size).toBe(D.ids.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("eido sink", () => {
  test("emits <slug>.eido that decodes back to the same map", () => {
    const D = synthMap();
    D.provenance = { title: "Synth Corpus!", count: D.ids.length };
    const dir = mkdtempSync(join(tmpdir(), "eido-sink-"));
    try {
      const files = eidoSink.emit(D, dir);
      expect(files[0].endsWith("synth-corpus.eido")).toBe(true);
      const back = decodeMap(readFileSync(files[0]));
      expect(back.ids).toEqual(D.ids);
      expect(back.k).toBe(D.k);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("slugify", () => {
  test("one slug rule", () => {
    expect(slugify("My Corpus (v2)")).toBe("my-corpus-v2");
    expect(slugify(undefined)).toBe("corpus");
    expect(slugify("!!!", "descent")).toBe("descent");
  });
});
