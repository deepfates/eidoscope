import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";

// The INPUT seam. Anything that yields { id, title, body } can drive the pipeline: a folder of
// files (folderSource), the readwise fixture (fixtureSource), or an HF-parquet/Reader adapter later.
export type Doc = { id: string; title: string; body: string; cat?: string; date?: number; url?: string; source?: string; siteName?: string; arxiv?: string; author?: string; tags?: string[]; path?: string; readProgress?: number };
const parseNum = (front: string, key: string) => { const m = front.match(new RegExp("^" + key + ":\\s*([\\d.]+)", "m")); return m ? Number(m[1]) : undefined; };
const parseDate = (front: string) => { const m = front.match(/^(?:created_at|date|published_date):\s*"?([^"\n]+)/m); const t = m ? Date.parse(m[1].trim()) : NaN; return isNaN(t) ? undefined : t; };

// A Source yields the corpus: docs (+ optional precomputed full-text embeddings — when absent the
// caller embeds locally). `describe` is a one-line human name for logs. Current implementations:
// folderSource (any folder of .md/.txt) and fixtureSource (the readwise fixture); an HF-parquet or
// Reader-API source is just another object with this shape.
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
  try {
    const m = JSON.parse(readFileSync(join(dir, "eidoscope-vault.json"), "utf8"));
    return m?.eidoscope === "vault" ? m : undefined;
  } catch { return undefined; }
}

export const fixtureSource = (): Source => ({
  describe: "readwise fixture (precomputed full-text embeddings)",
  load: () => loadFixture(),
});

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const stripMd = (raw: string) => raw.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim();

// Load any folder of .md/.markdown/.txt files (recursively). Frontmatter-aware: uses id/title if
// present, else derives them. This is the generic path — no precomputed embeddings, no fixture.
export function loadFolder(dir: string, opts: { limit?: number; minChars?: number } = {}): Doc[] {
  const min = opts.minChars ?? 200, userFloor = opts.minChars !== undefined, docs: Doc[] = [];
  let skipped = 0, vaultKept = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f); let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      const raw = readFileSync(p, "utf8");
      // binary bytes wearing a .md extension: null bytes or a high non-text ratio in the head means
      // this isn't prose — skip it with a warning instead of spending LLM calls carding garbage.
      // (utf8 decode turns invalid byte sequences into U+FFFD, so binary content shows up as those.)
      const head = raw.slice(0, 8192);
      let nonText = 0;
      for (let i = 0; i < head.length; i++) { const c = head.charCodeAt(i); if (c === 0 || c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) nonText++; }
      if (head.includes("\u0000") || (head.length > 0 && nonText / head.length > 0.3)) { console.error(`  ⚠ skipped binary-looking file (not text): ${p}`); continue; }
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const front = fm ? fm[1] : "", rest = fm ? fm[2] : raw;
      const body = stripMd(rest);
      // The junk floor filters garbage SOURCE docs. A vault card (eidoscope's own export — frontmatter
      // carries an id AND an axes block) is never junk, however short its restatement: dropping it would
      // break the export→re-ingest round trip the vault exists for. Exempt it, and say so.
      const isVaultCard = /^id:/m.test(front) && /^axes:/m.test(front);
      // the vault exemption defends the tool's OWN exports from the junk floor's DEFAULT — an
      // explicitly-asked floor is the user's call and wins over the exemption.
      if (body.length < min) { if (isVaultCard && !userFloor) vaultKept++; else { skipped++; continue; } }
      const id = (front.match(/^id:\s*"?([^"\n]+)/m) || [])[1]?.trim() || hash(p);
      const title = (front.match(/^title:\s*"?([^"\n]+)/m) || [])[1]?.trim()
        || (rest.match(/^#\s+(.+)$/m) || [])[1]?.trim()
        || basename(f).replace(/\.(md|markdown|txt)$/i, "");
      // capture whatever metadata the frontmatter carries; the file path is always a valid source.
      // Two links, kept distinct: `url` is the canonical/reader link (Readwise's `url:`), `source` is the
      // ORIGINAL the doc was saved from (`source_url:`/`source:` — arxiv, a blog, whoever). Keeping both
      // means a shared map can link out to the open original even for someone who can't open the reader.
      const clean = (s?: string) => s?.trim().replace(/[).,"']+$/, "");
      const frontUrl = clean((front.match(/^url:\s*"?([^"\n]+)/m) || [])[1]);
      const frontSrc = clean((front.match(/^(?:source_url|source):\s*"?([^"\n]+)/m) || [])[1]);
      const url = frontUrl || frontSrc
        || (rest.match(/https?:\/\/(?:arxiv\.org|doi\.org|dx\.doi\.org)\/\S+/i) || [])[0]?.replace(/[).,"']+$/, "")
        || (rest.slice(0, 600).match(/https?:\/\/[^\s)>"']+/) || [])[0]?.replace(/[).,"']+$/, "");
      const source = frontSrc && frontSrc !== url ? frontSrc : undefined;   // only when distinct from url
      const siteName = clean((front.match(/^site_name:\s*"?([^"\n]+)/m) || [])[1]);
      // arxiv id for the frontier telescope: the doc's OWN paper id, from the source_url / any arxiv
      // link in the frontmatter or the head of the body (stripMd removes urls, so read the raw `rest`).
      const arxiv = ((front + "\n" + rest.slice(0, 3000)).match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})|arxiv:\s*(\d{4}\.\d{4,5})/i) || []).slice(1).find(Boolean);
      const author = (front.match(/^author:\s*"?([^"\n]+)/m) || [])[1]?.trim();
      const tagsRaw = (front.match(/^tags:\s*(.+)$/m) || [])[1]?.trim();
      const tags = tagsRaw ? tagsRaw.replace(/[[\]"']/g, "").split(/,\s*/).map((t) => t.trim()).filter(Boolean) : undefined;
      docs.push({ id, title, body, date: parseDate(front), url: url || undefined, source: source || undefined, siteName: siteName || undefined, arxiv: arxiv || undefined, author: author || undefined, tags: tags?.length ? tags : undefined, path: resolve(p), readProgress: parseNum(front, "reading_progress") });
    }
  };
  walk(dir);
  // never drop docs silently: a corpus of short structured entries (reference cards, stat blocks) can
  // lose a big fraction to the length floor, and a quiet drop reads as "loaded everything" when it didn't.
  if (skipped) console.error(`  ⚠ skipped ${skipped} file(s) under ${min} chars of body (lower with --min-chars N to include short entries)`);
  if (vaultKept) console.error(`  kept ${vaultKept} vault card(s) under the ${min}-char floor (id + axes frontmatter — the floor filters junk sources, not eidoscope's own exports)`);
  // dedupe exact content twins (same title + body): exporters (e.g. Readwise) emit the same document
  // under multiple files, which becomes twin dots and twin neighbor-list entries on the map. Keep the
  // first occurrence, report the rest — same no-silent-drop rule as the length floor above.
  const seen = new Set<string>();
  const unique = docs.filter((d) => { const k = hash(d.title + "\u0000" + d.body); if (seen.has(k)) return false; seen.add(k); return true; });
  if (unique.length !== docs.length) console.error(`  ⚠ dropped ${docs.length - unique.length} exact duplicate(s) (same title + body under different files)`);
  return opts.limit ? unique.slice(0, opts.limit) : unique;
}

// Split any doc whose body exceeds the model's input maximum into the FEWEST contiguous pieces that fit.
// This is the only size rule in the pipeline and it exists for one non-negotiable reason: a doc that
// won't fit the LLM's context can't be carded. There is no semantic segmentation, no chosen piece count,
// no theory of "what a book is" — just contiguous slices sized to the limit (snapped to a space so we
// don't cut mid-word). Each piece is an ordinary Doc (id#k, "Title (part k/n)") that cards and embeds on
// its own; where the pieces land relative to each other and to everything else is left to the geometry.
export function splitOversized(docs: Doc[], maxChars: number): { docs: Doc[]; split: number; pieces: number } {
  if (!(maxChars > 0)) return { docs, split: 0, pieces: 0 };
  const out: Doc[] = []; let split = 0, pieces = 0;
  for (const d of docs) {
    if (d.body.length <= maxChars) { out.push(d); continue; }
    const parts: string[] = [];
    for (let pos = 0; pos < d.body.length;) {
      let end = Math.min(d.body.length, pos + maxChars);
      if (end < d.body.length) { const sp = d.body.lastIndexOf(" ", end); if (sp > pos + maxChars / 2) end = sp + 1; }
      parts.push(d.body.slice(pos, end));
      pos = end;
    }
    split++; pieces += parts.length;
    parts.forEach((body, k) => out.push({ ...d, id: `${d.id}#${k}`, title: `${d.title} (part ${k + 1}/${parts.length})`, body }));
  }
  return { docs: out, split, pieces };
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
