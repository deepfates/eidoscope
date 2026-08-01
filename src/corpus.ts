import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";

// The INPUT seam. Anything that yields { id, title, body } can drive the pipeline: a folder of
// files (loadFolder), the readwise fixture (loadFixture), or a splice/Reader adapter later.
export type Doc = { id: string; title: string; body: string; cat?: string; date?: number; url?: string; author?: string; tags?: string[]; path?: string; readProgress?: number };
const parseNum = (front: string, key: string) => { const m = front.match(new RegExp("^" + key + ":\\s*([\\d.]+)", "m")); return m ? Number(m[1]) : undefined; };
const parseDate = (front: string) => { const m = front.match(/^(?:created_at|date|published_date):\s*"?([^"\n]+)/m); const t = m ? Date.parse(m[1].trim()) : NaN; return isNaN(t) ? undefined : t; };

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const stripMd = (raw: string) => raw.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim();

// Load any folder of .md/.markdown/.txt files (recursively). Frontmatter-aware: uses id/title if
// present, else derives them. This is the generic path — no precomputed embeddings, no fixture.
export function loadFolder(dir: string, opts: { limit?: number; minChars?: number } = {}): Doc[] {
  const min = opts.minChars ?? 200, docs: Doc[] = [];
  let skipped = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f); let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      const raw = readFileSync(p, "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const front = fm ? fm[1] : "", rest = fm ? fm[2] : raw;
      const body = stripMd(rest);
      if (body.length < min) { skipped++; continue; }
      const id = (front.match(/^id:\s*"?([^"\n]+)/m) || [])[1]?.trim() || hash(p);
      const title = (front.match(/^title:\s*"?([^"\n]+)/m) || [])[1]?.trim()
        || (rest.match(/^#\s+(.+)$/m) || [])[1]?.trim()
        || basename(f).replace(/\.(md|markdown|txt)$/i, "");
      // capture whatever metadata the frontmatter carries; the file path is always a valid source.
      // URL: frontmatter first, else the raw text (stripMd deletes urls, so read them from `rest`).
      const url = (front.match(/^(?:url|source_url|source):\s*"?([^"\n]+)/m) || [])[1]?.trim()
        || (rest.match(/https?:\/\/(?:arxiv\.org|doi\.org|dx\.doi\.org)\/\S+/i) || [])[0]?.replace(/[).,"']+$/, "")
        || (rest.slice(0, 600).match(/https?:\/\/[^\s)>"']+/) || [])[0]?.replace(/[).,"']+$/, "");
      const author = (front.match(/^author:\s*"?([^"\n]+)/m) || [])[1]?.trim();
      const tagsRaw = (front.match(/^tags:\s*(.+)$/m) || [])[1]?.trim();
      const tags = tagsRaw ? tagsRaw.replace(/[[\]"']/g, "").split(/,\s*/).map((t) => t.trim()).filter(Boolean) : undefined;
      docs.push({ id, title, body, date: parseDate(front), url: url || undefined, author: author || undefined, tags: tags?.length ? tags : undefined, path: resolve(p), readProgress: parseNum(front, "reading_progress") });
    }
  };
  walk(dir);
  // never drop docs silently: a corpus of short structured entries (reference cards, stat blocks) can
  // lose a big fraction to the length floor, and a quiet drop reads as "loaded everything" when it didn't.
  if (skipped) console.error(`  ⚠ skipped ${skipped} file(s) under ${min} chars of body (lower with --min-chars N to include short entries)`);
  return opts.limit ? docs.slice(0, opts.limit) : docs;
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
