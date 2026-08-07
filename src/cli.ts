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
// eidoscope <folder> --debug-json    also dump the whole contract as map-data.json (debugging; big corpora OOM)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadFolder, loadFixture, splitOversized, type Doc } from "./corpus.ts";
import { embedDocs } from "./map.ts";
import { run, relabelMap, descendMap } from "./pipeline.ts";
import { encodeMap, decodeMap } from "./mapbin.ts";
import { singlefileHTML } from "./singlefile.ts";
import { CFG } from "./config.ts";

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a) => !a.startsWith("--"));
const limit = val("--limit") ? Number(val("--limit")) : undefined;

// descend: a viewer-exported Selection becomes its OWN map (eid-nuwd). The parent .eido already carries
// every card + the vectors its geometry was built on, so the child needs no corpus, no embedder, and no
// re-carding — only discovery/projection/clustering re-run over the subset, plus a few naming calls.
if (args[0] === "descend") {
  const VALFLAGS = new Set(["--out", "--name", "--limit", "--min-chars", "--embed"]);
  const pos: string[] = [];
  for (let i = 1; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) { if (VALFLAGS.has(a)) i++; continue; } pos.push(a); }
  const [parentPath, selPath] = pos;
  if (!parentPath || !selPath) { console.error("usage: eidoscope descend <parent.eido> <selection.json> [--out <dir>] [--name <title>]"); process.exit(1); }
  const P = decodeMap(readFileSync(parentPath));
  const selRaw = JSON.parse(readFileSync(selPath, "utf8"));
  const selIds: string[] = Array.isArray(selRaw) ? selRaw : selRaw.ids;   // the viewer's export ({ids,titles,urls}) or a bare id list
  if (!Array.isArray(selIds) || !selIds.length) { console.error(`descend: ${selPath} has no ids (expected the viewer's selection export)`); process.exit(1); }
  const D = await descendMap(P, selIds, { name: val("--name"), parentFile: basename(parentPath) });
  const slug = (D.provenance!.title!).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "descent";
  const outDir = val("--out") || join("out", slug);
  mkdirSync(outDir, { recursive: true });
  const enc = encodeMap(D);
  writeFileSync(join(outDir, slug + ".eido"), enc);
  const html = singlefileHTML(enc);
  if (html) writeFileSync(join(outDir, slug + ".html"), html);
  console.error(`\n✅ descended ${D.ids.length}/${P.ids.length} cards · ${D.axes.length} local axes · ${D.k} regions  →  ${outDir}/`);
  console.error(`   → map   ${join(outDir, slug + ".eido")}${html ? `\n   → open  ${join(outDir, slug + ".html")}` : ""}`);
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
