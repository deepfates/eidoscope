import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// The INPUT seam. Anything that yields { id, title, body } can drive the pipeline: a folder of
// files (loadFolder), the readwise fixture (loadFixture), or a splice/Reader adapter later.
export type Doc = { id: string; title: string; body: string; cat?: string; date?: number };
const parseDate = (front: string) => { const m = front.match(/^(?:created_at|date|published_date):\s*"?([^"\n]+)/m); const t = m ? Date.parse(m[1].trim()) : NaN; return isNaN(t) ? undefined : t; };

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const stripMd = (raw: string) => raw.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim();

// Load any folder of .md/.markdown/.txt files (recursively). Frontmatter-aware: uses id/title if
// present, else derives them. This is the generic path — no precomputed embeddings, no fixture.
export function loadFolder(dir: string, opts: { limit?: number; minChars?: number } = {}): Doc[] {
  const min = opts.minChars ?? 200, docs: Doc[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f); let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      const raw = readFileSync(p, "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const front = fm ? fm[1] : "", rest = fm ? fm[2] : raw;
      const body = stripMd(rest);
      if (body.length < min) continue;
      const id = (front.match(/^id:\s*"?([^"\n]+)/m) || [])[1]?.trim() || hash(p);
      const title = (front.match(/^title:\s*"?([^"\n]+)/m) || [])[1]?.trim()
        || (rest.match(/^#\s+(.+)$/m) || [])[1]?.trim()
        || basename(f).replace(/\.(md|markdown|txt)$/i, "");
      docs.push({ id, title, body, date: parseDate(front) });
    }
  };
  walk(dir);
  return opts.limit ? docs.slice(0, opts.limit) : docs;
}

const FIX = "/Users/deepfates/Hacking/readwise/triangulation/runs/main";
const MD = "/Users/deepfates/Hacking/readwise/markdown-export";

const strip = (raw: string) =>
  raw.split(/\n---\n/).slice(1).join("\n")
    .replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ").trim();

export function loadFixture(): { docs: Doc[]; embeddings: number[][] } {
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
    docs.push({ id: m.id, title: m.title || "", body: raw ? strip(raw) : "", cat: m.category, date: parseDate(front) });
    embeddings.push(C.embs[i]);
  });
  return { docs, embeddings };
}

export const fixtureAxes = () => JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
