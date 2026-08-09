// The OUTPUT seam. A Sink takes a finished MapContract and emits artifacts to a directory. This is
// where every "write the map somewhere" path goes through — the .eido bundle, the markdown vault, and
// later HF datasets / jsonl / parquet / merge-into-.eido are all just further implementations. The
// pipeline and the CLI never hand-write map artifacts; they pick a Sink and call emit.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MapContract } from "./schema.ts";
import { encodeMap } from "./mapbin.ts";
import { singlefileHTML } from "./singlefile.ts";

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

const yq = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';

// Markdown-vault sink: one .md file per card, frontmatter carrying the map's judgment about that card
// (id, per-axis scores, region, url). The point of this sink is the ROUND TRIP: a vault is itself a
// valid corpus for folderSource, so a map can be exported to plain readable files, edited/culled in any
// markdown tool (Obsidian et al.), and re-ingested — the curation loop with no proprietary step.
export const vaultSink: Sink = {
  name: "vault",
  emit(D, outDir) {
    mkdirSync(outDir, { recursive: true });
    // The manifest is how the round trip keeps identity: folderSource reads it and names the
    // re-ingested map after the SOURCE map, not the folder the vault happens to sit in.
    // (Not in the returned file list — callers count that list as "cards exported".)
    writeFileSync(join(outDir, "eidoscope-vault.json"), JSON.stringify({
      eidoscope: "vault", title: D.provenance?.title, source: D.provenance?.source,
      exported: Date.now(), count: D.ids.length,
    }, null, 2) + "\n");
    const files: string[] = [];
    const used = new Set<string>();
    const di = D.di ?? 0;
    const regionLabel = (i: number) => {
      const c = D.cluster[i];
      return D.levelLabels?.[di]?.[c] ?? D.clusters?.[c]?.label;
    };
    for (let i = 0; i < D.ids.length; i++) {
      let base = D.ids[i].replace(/[^A-Za-z0-9._-]+/g, "_") || "card";
      if (used.has(base)) { let k = 2; while (used.has(base + "-" + k)) k++; base = base + "-" + k; }
      used.add(base);
      const lines = ["---", `id: ${yq(D.ids[i])}`, `title: ${yq(D.titles[i] || D.ids[i])}`];
      const url = D.urls?.[i]; if (url) lines.push(`url: ${yq(url)}`);
      const region = regionLabel(i); if (region != null) lines.push(`region: ${yq(region)}`);
      lines.push("axes:");
      for (const a of D.axes) lines.push(`  ${a.key}: ${D.scores[a.key]?.[i] ?? ""}`);
      lines.push("---", "", D.cores[i] || "");
      const notes = D.notes[i] || {};
      const placed = D.axes.filter((a) => notes[a.key]);
      if (placed.length) {
        lines.push("", "## Placements", "");
        for (const a of placed) lines.push(`- **${a.name}** (${a.low} ⇄ ${a.high}): ${notes[a.key]}`);
      }
      const p = join(outDir, base + ".md");
      writeFileSync(p, lines.join("\n") + "\n");
      files.push(p);
    }
    return files;
  },
};
