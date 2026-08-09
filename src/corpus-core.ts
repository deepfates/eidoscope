// HOST-FREE document parsing — the ONE set of rules for turning a source file into a Doc, shared by the
// filesystem walker (src/corpus.ts loadFolder) and the in-page folder ingest (viewer/src/ingest.ts).
// The 200-char junk floor, the binary sniff, the frontmatter/metadata parse and the exact-duplicate
// collapse all live here exactly once — two hosts, one truth about what a document is.

export type Doc = { id: string; title: string; body: string; cat?: string; date?: number; url?: string; source?: string; siteName?: string; arxiv?: string; author?: string; tags?: string[]; path?: string; readProgress?: number };

export const SOURCE_EXT = /\.(md|markdown|txt)$/i;
export const DEFAULT_MIN_CHARS = 200;

export const parseNum = (front: string, key: string) => { const m = front.match(new RegExp("^" + key + ":\\s*([\\d.]+)", "m")); return m ? Number(m[1]) : undefined; };
export const parseDate = (front: string) => { const m = front.match(/^(?:created_at|date|published_date):\s*"?([^"\n]+)/m); const t = m ? Date.parse(m[1].trim()) : NaN; return isNaN(t) ? undefined : t; };

export const docHash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const stripMd = (raw: string) => raw.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim();

// binary bytes wearing a .md extension: null bytes or a high non-text ratio in the head means this
// isn't prose — the caller skips it with a warning instead of spending LLM calls carding garbage.
// (utf8 decode turns invalid byte sequences into U+FFFD, so binary content shows up as those.)
export function looksBinary(raw: string): boolean {
  const head = raw.slice(0, 8192);
  let nonText = 0;
  for (let i = 0; i < head.length; i++) { const c = head.charCodeAt(i); if (c === 0 || c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) nonText++; }
  return head.includes("\u0000") || (head.length > 0 && nonText / head.length > 0.3);
}

export type ParsedFile =
  | { skip: "binary" | "short"; doc?: undefined; vaultKept?: undefined }
  | { skip?: undefined; doc: Doc; vaultKept: boolean };

// Parse ONE source file into a Doc (or a named skip). `path` is whatever the host calls the file (an
// absolute fs path or a webkitRelativePath); `name` its basename. Frontmatter-aware: uses id/title if
// present, else derives them.
export function parseSourceFile(path: string, name: string, raw: string, opts: { minChars?: number } = {}): ParsedFile {
  const min = opts.minChars ?? DEFAULT_MIN_CHARS, userFloor = opts.minChars !== undefined;
  if (looksBinary(raw)) return { skip: "binary" };
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const front = fm ? fm[1] : "", rest = fm ? fm[2] : raw;
  const body = stripMd(rest);
  // The junk floor filters garbage SOURCE docs. A vault card (eidoscope's own export — frontmatter
  // carries an id AND an axes block) is never junk, however short its restatement: dropping it would
  // break the export→re-ingest round trip the vault exists for. Exempt it (unless the user asked for
  // an explicit floor, which wins).
  const isVaultCard = /^id:/m.test(front) && /^axes:/m.test(front);
  let vaultKept = false;
  if (body.length < min) { if (isVaultCard && !userFloor) vaultKept = true; else return { skip: "short" }; }
  const id = (front.match(/^id:\s*"?([^"\n]+)/m) || [])[1]?.trim() || docHash(path);
  const title = (front.match(/^title:\s*"?([^"\n]+)/m) || [])[1]?.trim()
    || (rest.match(/^#\s+(.+)$/m) || [])[1]?.trim()
    || name.replace(SOURCE_EXT, "");
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
  return {
    doc: { id, title, body, date: parseDate(front), url: url || undefined, source: source || undefined, siteName: siteName || undefined, arxiv: arxiv || undefined, author: author || undefined, tags: tags?.length ? tags : undefined, path, readProgress: parseNum(front, "reading_progress") },
    vaultKept,
  };
}

// dedupe exact content twins (same title + body): exporters (e.g. Readwise) emit the same document
// under multiple files, which becomes twin dots and twin neighbor-list entries on the map. Keep the
// first occurrence; the caller reports the count (no-silent-drop rule).
export function dedupeDocs(docs: Doc[]): { docs: Doc[]; dropped: number } {
  const seen = new Set<string>();
  const unique = docs.filter((d) => { const k = docHash(d.title + "\u0000" + d.body); if (seen.has(k)) return false; seen.add(k); return true; });
  return { docs: unique, dropped: docs.length - unique.length };
}

// A vault (vaultSink's export) announces itself with a manifest so the round trip keeps the source
// map's identity. Pure parse — the host reads the file/File and hands the text here.
export function parseVaultManifest(text: string): { title?: string; source?: string } | undefined {
  try { const m = JSON.parse(text); return m?.eidoscope === "vault" ? m : undefined; } catch { return undefined; }
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

// Assemble a corpus from already-read files (any host): parse each, apply the floor/sniff, dedupe, and
// report every drop by name/count — the SAME honesty lines both hosts print. Files are processed in the
// order given (the fs walker and the folder picker both hand them over in directory order).
export function docsFromFiles(
  files: { path: string; name: string; text: string }[],
  opts: { limit?: number; minChars?: number; warn?: (line: string) => void } = {},
): Doc[] {
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const min = opts.minChars ?? DEFAULT_MIN_CHARS;
  const docs: Doc[] = [];
  let skipped = 0, vaultKept = 0;
  for (const f of files) {
    if (!SOURCE_EXT.test(f.name)) continue;
    const r = parseSourceFile(f.path, f.name, f.text, { minChars: opts.minChars });
    if (r.skip) { if (r.skip === "binary") warn(`  ⚠ skipped binary-looking file (not text): ${f.path}`); else skipped++; continue; }
    if (r.vaultKept) vaultKept++;
    docs.push(r.doc);
  }
  // never drop docs silently: a corpus of short structured entries (reference cards, stat blocks) can
  // lose a big fraction to the length floor, and a quiet drop reads as "loaded everything" when it didn't.
  if (skipped) warn(`  ⚠ skipped ${skipped} file(s) under ${min} chars of body (lower with --min-chars N to include short entries)`);
  if (vaultKept) warn(`  kept ${vaultKept} vault card(s) under the ${min}-char floor (id + axes frontmatter — the floor filters junk sources, not eidoscope's own exports)`);
  const { docs: unique, dropped } = dedupeDocs(docs);
  if (dropped) warn(`  ⚠ dropped ${dropped} exact duplicate(s) (same title + body under different files)`);
  return opts.limit ? unique.slice(0, opts.limit) : unique;
}
