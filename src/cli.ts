#!/usr/bin/env bun
// eidoscope <folder> [--limit N]     run on any folder of .md/.txt files → out/<slug>/<slug>.eido
// eidoscope <folder> --out <dir>     write the output bundle to <dir> instead of out/<slug>/
// eidoscope --fixture                run on the readwise fixture (precomputed embeddings)
// eidoscope <folder> --frontier      also pull the Semantic Scholar citation frontier (arxiv corpora)
// eidoscope <folder> --embed raw     build the map from raw full-text instead of cards (A/B the bottleneck)
// eidoscope --relabel <dir>          re-name regions of an existing map (no re-carding) + re-render in place
// eidoscope descend <parent.eido> <selection.json> [--out <dir>] [--name <title>]
//                                    re-map a viewer-exported Selection as its OWN child map (new local axes
//                                    from the parent's carried card vectors; cards reused, no re-carding)
// eidoscope export <map.eido> [--out <dir>]
//                                    export a map as a markdown VAULT: one .md per card with frontmatter
//                                    (id, per-axis scores, region, url) — readable anywhere, and itself a
//                                    valid corpus (`eidoscope <vault-dir>` re-ingests it: the curation loop)
// eidoscope <folder> --debug-json    also dump the whole contract as map-data.json (debugging; big corpora OOM)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { folderSource, fixtureSource, splitOversized, type Source } from "./corpus.ts";
import { embedDocs } from "./map.ts";
import { run, relabelMap, descendMap } from "./pipeline.ts";
import { decodeMap } from "./mapbin.ts";
import { eidoSink, vaultSink, slugify } from "./sink.ts";
import { CFG } from "./config.ts";

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a) => !a.startsWith("--"));
const limit = val("--limit") ? Number(val("--limit")) : undefined;

// positional args after a subcommand, skipping value-taking flags
const positional = (from: number, valflags: Set<string>) => {
  const pos: string[] = [];
  for (let i = from; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) { if (valflags.has(a)) i++; continue; } pos.push(a); }
  return pos;
};

// export: a decoded map goes OUT through a sink (src/sink.ts). Today: the markdown vault.
if (args[0] === "export") {
  const [mapPath] = positional(1, new Set(["--out"]));
  if (!mapPath) { console.error("usage: eidoscope export <map.eido> [--out <dir>]"); process.exit(1); }
  const D = decodeMap(readFileSync(mapPath));
  const outDir = val("--out") || join("out", slugify(D.provenance?.title, basename(mapPath, ".eido")) + "-vault");
  const files = vaultSink.emit(D, outDir);
  console.error(`\n✅ exported ${files.length} cards as a markdown vault  →  ${outDir}/`);
  console.error(`   (a vault is itself a corpus: \`eidoscope ${outDir}\` re-ingests it)`);
  process.exit(0);
}

// descend: a viewer-exported Selection becomes its OWN map (eid-nuwd). The parent .eido already carries
// every card + the vectors its geometry was built on, so the child needs no corpus, no embedder, and no
// re-carding — only discovery/projection/clustering re-run over the subset, plus a few naming calls.
if (args[0] === "descend") {
  const [parentPath, selPath] = positional(1, new Set(["--out", "--name", "--limit", "--min-chars", "--embed"]));
  if (!parentPath || !selPath) { console.error("usage: eidoscope descend <parent.eido> <selection.json> [--out <dir>] [--name <title>]"); process.exit(1); }
  const P = decodeMap(readFileSync(parentPath));
  const selRaw = JSON.parse(readFileSync(selPath, "utf8"));
  const selIds: string[] = Array.isArray(selRaw) ? selRaw : selRaw.ids;   // the viewer's export ({ids,titles,urls}) or a bare id list
  if (!Array.isArray(selIds) || !selIds.length) { console.error(`descend: ${selPath} has no ids (expected the viewer's selection export)`); process.exit(1); }
  const D = await descendMap(P, selIds, { name: val("--name"), parentFile: basename(parentPath) });
  const slug = slugify(D.provenance!.title, "descent");
  const outDir = val("--out") || join("out", slug);
  const files = eidoSink.emit(D, outDir, { slug });
  const html = files.find((f) => f.endsWith(".html"));
  console.error(`\n✅ descended ${D.ids.length}/${P.ids.length} cards · ${D.axes.length} local axes · ${D.k} regions  →  ${outDir}/`);
  console.error(`   → map   ${files[0]}${html ? `\n   → open  ${html}` : ""}`);
  process.exit(0);
}

// --relabel: geometry is cached; only the names drift. Re-name from stored cards, re-render, done.
if (args.includes("--relabel")) {
  const d = dir; if (!d) { console.error("usage: eidoscope --relabel <dir-with-a-.eido>"); process.exit(1); }
  // Read the map from the bundle: the .eido is the real artifact (map-data.json is now debug-only, so a
  // default run leaves none). Fall back to map-data.json when a --debug-json run wrote one.
  const eidos = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".eido")).sort() : [];
  const jsonPath = join(d, "map-data.json"), hasJSON = existsSync(jsonPath);
  if (!eidos.length && !hasJSON) { console.error(`no .eido (or map-data.json) found in ${d}`); process.exit(1); }
  // Write back to the SAME names we read — a bundle is `<slug>.eido` + `<slug>.html` next to each other, and
  // relabeling used to clobber it with a hardcoded map.eido/eidoscope.html pair, orphaning the real files.
  const eidoName = eidos[0] ?? "map.eido", slug = basename(eidoName, ".eido");
  const D = eidos.length ? decodeMap(readFileSync(join(d, eidoName))) : JSON.parse(readFileSync(jsonPath, "utf8"));
  const D2 = await relabelMap(D, { cacheDir: d });
  if (hasJSON) writeFileSync(jsonPath, JSON.stringify(D2));
  const files = eidoSink.emit(D2, d, { slug });   // re-encode so the .eido carries the new labels (the viewer reads it)
  const html = files.find((f) => f.endsWith(".html"));
  console.error(`\n✅ relabeled ${D2.counts?.length ?? 1} grain levels → ${files[0]}${html ? ` + ${basename(html)}` : ""}`);
  process.exit(0);
}

// The default path: pick a SOURCE (src/corpus.ts), load docs (+embeddings when the source carries them,
// else embed locally), then run the pipeline.
let source: Source;
if (args.includes("--fixture")) source = fixtureSource();
else {
  if (!dir) { console.error("usage: eidoscope <folder> [--limit N]   |   eidoscope --fixture"); process.exit(1); }
  source = folderSource(dir, { limit, minChars: val("--min-chars") ? Number(val("--min-chars")) : undefined });
}
let { docs, embeddings } = await source.load();
if (!docs.length) { console.error(`no documents found (${source.describe})`); process.exit(1); }
if (embeddings) {
  console.error(`${source.describe}: ${docs.length} docs`);
} else {
  // respect the LLM input max: split only docs that exceed it, into contiguous pieces (corpus.ts)
  const loaded = docs.length;
  const sp = splitOversized(docs, CFG.params.maxDocChars); docs = sp.docs;
  if (sp.split) console.error(`  split ${sp.split} oversized doc(s) into ${sp.pieces} pieces (> ${CFG.params.maxDocChars} chars, the input max)`);
  console.error(`loaded ${loaded} docs (${source.describe})${sp.split ? ` → ${docs.length} after splitting` : ""}; embedding full text (local MiniLM)…`);
  embeddings = await embedDocs(docs);
}
const name = args.includes("--fixture") ? "Readwise library" : (dir?.split("/").filter(Boolean).pop() || "Corpus");
const embed = val("--embed") === "raw" ? "raw" : "card";
await run(docs, embeddings, { frontier: args.includes("--frontier"), name, source: dir, embed, out: val("--out"), debugJson: args.includes("--debug-json") });
