#!/usr/bin/env bun
// eidoscope <folder> [--limit N]     run on any folder of .md/.txt files
// eidoscope --fixture                run on the readwise fixture (precomputed embeddings)
import { loadFolder, loadFixture, type Doc } from "./corpus.ts";
import { embedDocs } from "./map.ts";
import { run } from "./pipeline.ts";

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a) => !a.startsWith("--"));
const limit = val("--limit") ? Number(val("--limit")) : undefined;

let docs: Doc[], embeddings: number[][];
if (args.includes("--fixture")) {
  const fx = loadFixture(); docs = fx.docs; embeddings = fx.embeddings;
  console.error(`fixture: ${docs.length} docs (precomputed full-text embeddings)`);
} else {
  if (!dir) { console.error("usage: eidoscope <folder> [--limit N]   |   eidoscope --fixture"); process.exit(1); }
  docs = loadFolder(dir, { limit });
  if (!docs.length) { console.error(`no .md/.txt documents found under ${dir}`); process.exit(1); }
  console.error(`loaded ${docs.length} docs from ${dir}; embedding full text (curare)…`);
  embeddings = await embedDocs(docs);
}
await run(docs, embeddings);
