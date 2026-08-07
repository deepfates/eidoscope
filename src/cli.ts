#!/usr/bin/env bun
// eidoscope <folder> [--limit N]     run on any folder of .md/.txt files → out/<slug>/<slug>.eido
// eidoscope <folder> --out <dir>     write the output bundle to <dir> instead of out/<slug>/
// eidoscope --fixture                run on the readwise fixture (precomputed embeddings)
// eidoscope <folder> --frontier      also pull the Semantic Scholar citation frontier (arxiv corpora)
// eidoscope <folder> --embed raw     build the map from raw full-text instead of cards (A/B the bottleneck)
// eidoscope --relabel <dir>          re-name regions of an existing map (no re-carding) + re-render in place
// eidoscope <folder> --debug-json    also dump the whole contract as map-data.json (debugging; big corpora OOM)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadFolder, loadFixture, splitOversized, type Doc } from "./corpus.ts";
import { embedDocs } from "./map.ts";
import { run, relabelMap } from "./pipeline.ts";
import { encodeMap, decodeMap } from "./mapbin.ts";
import { singlefileHTML } from "./singlefile.ts";
import { CFG } from "./config.ts";

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a) => !a.startsWith("--"));
const limit = val("--limit") ? Number(val("--limit")) : undefined;

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
  const enc = encodeMap(D2);                       // re-encode so the .eido carries the new labels (the viewer reads it)
  writeFileSync(join(d, eidoName), enc);
  const htmlName = slug + ".html", html = singlefileHTML(enc);
  if (html) writeFileSync(join(d, htmlName), html);
  console.error(`\n✅ relabeled ${D2.counts?.length ?? 1} grain levels → ${join(d, eidoName)}${html ? ` + ${htmlName}` : ""}`);
  process.exit(0);
}

let docs: Doc[], embeddings: number[][];
if (args.includes("--fixture")) {
  const fx = loadFixture(); docs = fx.docs; embeddings = fx.embeddings;
  console.error(`fixture: ${docs.length} docs (precomputed full-text embeddings)`);
} else {
  if (!dir) { console.error("usage: eidoscope <folder> [--limit N]   |   eidoscope --fixture"); process.exit(1); }
  docs = loadFolder(dir, { limit, minChars: val("--min-chars") ? Number(val("--min-chars")) : undefined });
  if (!docs.length) { console.error(`no .md/.txt documents found under ${dir}`); process.exit(1); }
  // respect the LLM input max: split only docs that exceed it, into contiguous pieces (corpus.ts)
  const loaded = docs.length;
  const sp = splitOversized(docs, CFG.params.maxDocChars); docs = sp.docs;
  if (sp.split) console.error(`  split ${sp.split} oversized doc(s) into ${sp.pieces} pieces (> ${CFG.params.maxDocChars} chars, the input max)`);
  console.error(`loaded ${loaded} docs from ${dir}${sp.split ? ` → ${docs.length} after splitting` : ""}; embedding full text (local MiniLM)…`);
  embeddings = await embedDocs(docs);
}
const name = args.includes("--fixture") ? "Readwise library" : (dir?.split("/").filter(Boolean).pop() || "Corpus");
const embed = val("--embed") === "raw" ? "raw" : "card";
await run(docs, embeddings, { frontier: args.includes("--frontier"), name, source: dir, embed, out: val("--out"), debugJson: args.includes("--debug-json") });
