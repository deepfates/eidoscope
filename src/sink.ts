// The OUTPUT seam. A Sink takes a finished MapContract and emits artifacts to a directory. This is
// where every "write the map somewhere" path goes through — the .eido bundle, the markdown vault, and
// later HF datasets / jsonl / parquet / merge-into-.eido are all just further implementations. The
// pipeline and the CLI never hand-write map artifacts; they pick a Sink and call emit.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MapContract } from "./schema.ts";
import { encodeMap } from "./mapbin.ts";
import { singlefileHTML } from "./singlefile.ts";
import { vaultEntries, deckJSONL } from "./export.ts";

export interface Sink {
  name: string;
  // Write this map's artifacts under outDir; returns the paths written (callers do their own logging).
  emit(D: MapContract, outDir: string, opts?: { slug?: string }): string[];
}

// The ONE slug rule (was hand-copied in cli.ts run/descend and pipeline.ts).
export const slugify = (s: string | undefined, fallback = "corpus") =>
  (s || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;

// The default sink: `<slug>.eido` (the portable L-space) + `<slug>.html` (the self-contained offline
// viewer with the payload inlined — skipped, not failed, when viewer/dist isn't built).
export const eidoSink: Sink = {
  name: "eido",
  emit(D, outDir, opts = {}) {
    // an empty map is not a map — refusing here makes "emit 0 cards as success" structurally impossible
    if (!D.ids.length) throw new Error("refusing to emit an empty map (0 cards)");
    const slug = opts.slug ?? slugify(D.provenance?.title);
    mkdirSync(outDir, { recursive: true });
    const enc = encodeMap(D);
    const files: string[] = [];
    const eidoPath = join(outDir, slug + ".eido");
    writeFileSync(eidoPath, enc); files.push(eidoPath);
    const html = singlefileHTML(enc);
    if (html) { const htmlPath = join(outDir, slug + ".html"); writeFileSync(htmlPath, html); files.push(htmlPath); }
    return files;
  },
};

// Markdown-vault sink: the pure entries live in src/export.ts (shared with the app's Export menu —
// same emit, zipped client-side there, written to a directory here). The point of this sink is the
// ROUND TRIP: a vault is itself a valid corpus for folderSource, so a map can be exported to plain
// readable files, edited/culled in any markdown tool (Obsidian et al.), and re-ingested — the
// curation loop with no proprietary step.
export const vaultSink: Sink = {
  name: "vault",
  emit(D, outDir) {
    mkdirSync(outDir, { recursive: true });
    const { manifest, cards } = vaultEntries(D);
    // The manifest is how the round trip keeps identity: folderSource reads it and names the
    // re-ingested map after the SOURCE map, not the folder the vault happens to sit in.
    // (Not in the returned file list — callers count that list as "cards exported".)
    writeFileSync(join(outDir, manifest.name), manifest.text);
    const files: string[] = [];
    for (const c of cards) { const p = join(outDir, c.name); writeFileSync(p, c.text); files.push(p); }
    return files;
  },
};

// Deck sink: the corpus as card-shaped JSONL rows (src/export.ts deckJSONL) — the same artifact the
// app's Export → deck JSONL downloads, written to a directory here.
export const deckSink: Sink = {
  name: "deck",
  emit(D, outDir, opts = {}) {
    mkdirSync(outDir, { recursive: true });
    const slug = opts.slug ?? slugify(D.provenance?.title);
    const p = join(outDir, slug + "-deck.jsonl");
    writeFileSync(p, deckJSONL(D));
    return [p];
  },
};
