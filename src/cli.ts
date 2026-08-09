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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { folderSource, fixtureSource, splitOversized, type Source } from "./corpus.ts";
import { embedDocs } from "./map.ts";
import { run, relabelMap, descendMap } from "./pipeline.ts";
import { decodeMap } from "./mapbin.ts";
import { eidoSink, vaultSink, slugify } from "./sink.ts";
import { CFG } from "./config.ts";
import type { MapContract } from "./schema.ts";

// The truth about what this binary does — every verb and flag here exists in this file, no more, no less.
const USAGE = `usage: eidoscope <folder> [flags]                 map any folder of .md/.txt files → out/<slug>/
       eidoscope example                          try it on the bundled demo corpus
       eidoscope export <map.eido> [--out <dir>]  export a map as a markdown vault (itself a valid corpus)
       eidoscope descend <parent.eido> <selection.json> [--out <dir>] [--name <title>]
                                                  re-map a viewer-exported selection as its own child map
       eidoscope --relabel <dir-with-a-.eido>     re-name regions of an existing map (no re-carding)
       eidoscope --fixture                        run on the readwise fixture (needs EIDOSCOPE_FIXTURE*)

flags: --limit N        map only the first N documents
       --min-chars N    include short entries (default: skip bodies < 200 chars)
       --frontier       also pull the Semantic Scholar citation frontier (arxiv corpora)
       --embed raw      build the map from raw full-text instead of cards (A/B the bottleneck)
       --out <dir>      write the output bundle to <dir> instead of out/<slug>/
       --name <title>   title for a descended map
       --debug-json     also dump map-data.json (debugging; OOMs on big corpora)

env:   OPENROUTER_API_KEY or EIDOSCOPE_API_KEY (the LLM), EIDOSCOPE_API_URL (any OpenAI-compatible
       endpoint; default OpenRouter), EIDOSCOPE_MODEL, EIDOSCOPE_CONCURRENCY`;

// One honest line for a foreseeable failure — no stack, exit 1.
const die = (msg: string): never => { console.error(msg); process.exit(1); };

// The LLM key is required for anything that cards or names. Check BEFORE loading/embedding, and name
// the real env vars — a stranger deserves the fix in the first line, not an SDK stack trace.
const preflightKey = () => {
  if (!CFG.key && !process.env.EIDOSCOPE_API_URL)
    die("no API key: set OPENROUTER_API_KEY or EIDOSCOPE_API_KEY (or point EIDOSCOPE_API_URL at a local OpenAI-compatible server)");
};

// Read + decode a .eido, converting the two foreseeable failures into one-line messages.
const readEido = (path: string): MapContract => {
  if (!existsSync(path)) die(`no such file: ${path}`);
  try { return decodeMap(readFileSync(path)); }
  catch { return die(`not a valid .eido (corrupt or not this format): ${path}`); }
};

// Run an async command; a thrown guard error prints its message plainly (the throw dressing is noise).
const attempt = async (fn: () => Promise<void>) => {
  try { await fn(); }
  catch (e: any) {
    if (process.env.EIDOSCOPE_DEBUG) console.error(e);
    die(String(e?.message ?? e));
  }
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }
if (!args.length) { console.error(USAGE); process.exit(1); }
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
  const D = readEido(mapPath);
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
  preflightKey();   // descend names local axes + regions with the LLM
  const P = readEido(parentPath);
  if (!existsSync(selPath)) die(`no such file: ${selPath}`);
  let selRaw: any;
  try { selRaw = JSON.parse(readFileSync(selPath, "utf8")); }
  catch { die(`${selPath} is not valid JSON (expected the viewer's selection export)`); }
  const selIds: string[] = Array.isArray(selRaw) ? selRaw : selRaw?.ids;   // the viewer's export ({ids,titles,urls}) or a bare id list
  if (!Array.isArray(selIds) || !selIds.length) { console.error(`descend: ${selPath} has no ids (expected the viewer's selection export)`); process.exit(1); }
  await attempt(async () => {
    const D = await descendMap(P, selIds, { name: val("--name"), parentFile: basename(parentPath) });
    const slug = slugify(D.provenance!.title, "descent");
    const outDir = val("--out") || join("out", slug);
    const files = eidoSink.emit(D, outDir, { slug });
    const html = files.find((f) => f.endsWith(".html"));
    console.error(`\n✅ descended ${D.ids.length}/${P.ids.length} cards · ${D.axes.length} local axes · ${D.k} regions  →  ${outDir}/`);
    console.error(`   → map   ${files[0]}${html ? `\n   → open  ${html}` : ""}`);
  });
  process.exit(0);
}

// --relabel: geometry is cached; only the names drift. Re-name from stored cards, re-render, done.
if (args.includes("--relabel")) {
  const d = dir; if (!d) { console.error("usage: eidoscope --relabel <dir-with-a-.eido>"); process.exit(1); }
  preflightKey();   // relabeling is LLM naming calls
  // Read the map from the bundle: the .eido is the real artifact (map-data.json is now debug-only, so a
  // default run leaves none). Fall back to map-data.json when a --debug-json run wrote one.
  const eidos = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".eido")).sort() : [];
  const jsonPath = join(d, "map-data.json"), hasJSON = existsSync(jsonPath);
  if (!eidos.length && !hasJSON) { console.error(`no .eido (or map-data.json) found in ${d}`); process.exit(1); }
  // Write back to the SAME names we read — a bundle is `<slug>.eido` + `<slug>.html` next to each other, and
  // relabeling used to clobber it with a hardcoded map.eido/eidoscope.html pair, orphaning the real files.
  const eidoName = eidos[0] ?? "map.eido", slug = basename(eidoName, ".eido");
  const D = eidos.length ? readEido(join(d, eidoName)) : JSON.parse(readFileSync(jsonPath, "utf8"));
  await attempt(async () => {
    const D2 = await relabelMap(D, { cacheDir: d });
    if (hasJSON) writeFileSync(jsonPath, JSON.stringify(D2));
    const files = eidoSink.emit(D2, d, { slug });   // re-encode so the .eido carries the new labels (the viewer reads it)
    const html = files.find((f) => f.endsWith(".html"));
    console.error(`\n✅ relabeled ${D2.counts?.length ?? 1} grain levels → ${files[0]}${html ? ` + ${basename(html)}` : ""}`);
  });
  process.exit(0);
}

// The default path: pick a SOURCE (src/corpus.ts), load docs (+embeddings when the source carries them,
// else embed locally), then run the pipeline.
preflightKey();   // before any loading/embedding — the run will need the LLM to card
let source: Source;
if (args.includes("--fixture")) source = fixtureSource();
else {
  if (!dir) { console.error(USAGE); process.exit(1); }
  if (!existsSync(dir)) die(`no such folder: ${dir}`);
  if (!statSync(dir).isDirectory()) die(`not a folder: ${dir}${dir.endsWith(".eido") ? ` (to export a map, use \`eidoscope export ${dir}\`)` : ""}`);
  source = folderSource(dir, { limit, minChars: val("--min-chars") ? Number(val("--min-chars")) : undefined });
}
await attempt(async () => {
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
});
