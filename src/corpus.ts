import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { docsFromFiles, parseVaultManifest, parseNum, parseDate, type Doc } from "./corpus-core.ts";

// The INPUT seam (node face). Anything that yields { id, title, body } can drive the pipeline: a folder
// of files (folderSource), the readwise fixture (fixtureSource), or an HF-parquet/Reader adapter later.
// The parsing RULES (junk floor, binary sniff, frontmatter, dedupe) are host-free in src/corpus-core.ts,
// shared verbatim with the in-page folder ingest — this file only walks the filesystem.
export type { Doc };
export { splitOversized } from "./corpus-core.ts";

// A Source yields the corpus: docs (+ optional precomputed full-text embeddings — when absent the
// caller embeds locally). `describe` is a one-line human name for logs.
export interface Source {
  describe: string;
  load(): Promise<{ docs: Doc[]; embeddings?: number[][]; title?: string }> | { docs: Doc[]; embeddings?: number[][]; title?: string };
}

export const folderSource = (dir: string, opts: { limit?: number; minChars?: number } = {}): Source => ({
  describe: `folder ${dir}`,
  load: () => ({ docs: loadFolder(dir, opts), title: readVaultManifest(dir)?.title }),
});

// A vault (vaultSink's export) announces itself with a manifest so the round trip keeps the source
// map's identity: re-ingesting a vault names the new map after the map it came from, not the temp
// folder it happens to sit in. Absent or malformed manifest → plain folder, no behavior change.
export function readVaultManifest(dir: string): { title?: string; source?: string } | undefined {
  try { return parseVaultManifest(readFileSync(join(dir, "eidoscope-vault.json"), "utf8")); } catch { return undefined; }
}

export const fixtureSource = (): Source => ({
  describe: "readwise fixture (precomputed full-text embeddings)",
  load: () => loadFixture(),
});

// Load any folder of .md/.markdown/.txt files (recursively) through the shared corpus-core rules.
export function loadFolder(dir: string, opts: { limit?: number; minChars?: number } = {}): Doc[] {
  const files: { path: string; name: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f); let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      files.push({ path: resolve(p), name: f, text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return docsFromFiles(files, opts);
}

// The fixture (`--fixture`) is a personal corpus with precomputed embeddings; point these at your own
// via EIDOSCOPE_FIXTURE / EIDOSCOPE_FIXTURE_MD (e.g. in a gitignored .env — bun auto-loads it). Most
// users don't need it: `bun run src/cli.ts <folder>` works on any folder of .md/.txt with no setup.
const FIX = process.env.EIDOSCOPE_FIXTURE ?? "";
const MD = process.env.EIDOSCOPE_FIXTURE_MD ?? "";

const strip = (raw: string) =>
  raw.split(/\n---\n/).slice(1).join("\n")
    .replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ").trim();

export function loadFixture(): { docs: Doc[]; embeddings: number[][] } {
  if (!FIX || !MD) throw new Error("--fixture needs EIDOSCOPE_FIXTURE + EIDOSCOPE_FIXTURE_MD set (a dir with corpus-fulltext.json + clean-ids.json, and a markdown dir). Most users want `bun run src/cli.ts <folder>` instead.");
  const C = JSON.parse(readFileSync(`${FIX}/corpus-fulltext.json`, "utf8"));
  const keep = new Set(JSON.parse(readFileSync(`${FIX}/clean-ids.json`, "utf8")).keep);
  const idToFile = new Map<string, string>();
  for (const f of readdirSync(MD)) { if (!f.endsWith(".md")) continue; const id = (readFileSync(`${MD}/${f}`, "utf8").match(/^id:\s*"([^"]+)"/m) || [])[1]; if (id) idToFile.set(id, f); }
  const docs: Doc[] = [], embeddings: number[][] = [];
  C.meta.forEach((m: any, i: number) => {
    if (!keep.has(m.id)) return;
    const f = idToFile.get(m.id);
    const raw = f ? readFileSync(`${MD}/${f}`, "utf8") : "";
    const front = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
    const src = (front.match(/^(?:source_url|url):\s*"?([^"\n]+)/m) || [])[1]?.trim();
    docs.push({ id: m.id, title: m.title || "", body: raw ? strip(raw) : "", cat: m.category, date: parseDate(front), author: m.author, url: src || `https://read.readwise.io/read/${m.id}`, path: f ? `${MD}/${f}` : undefined, readProgress: m.reading_progress ?? parseNum(front, "reading_progress") });
    embeddings.push(C.embs[i]);
  });
  return { docs, embeddings };
}

export const fixtureAxes = () => JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
