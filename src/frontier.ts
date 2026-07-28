import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Doc } from "./corpus.ts";
import type { Axis } from "./axes.ts";
import { cardCorpus } from "./card.ts";
import { getTextEmbeddings } from "./embed.ts";
import { cardText } from "./map.ts";

// THE TELESCOPE: reach outside the corpus. Via Semantic Scholar (by arxiv id) we get (1) intra-corpus
// citation EDGES, (2) real citation-count impact, and (3) the external FRONTIER — papers the library
// cites/that cite it but doesn't contain, ranked by how many of your docs connect to each. The top
// frontier papers are then carded into the SAME axes and placed as "ghost" points where they'd sit.
// Academic feature: a clean no-op when the corpus has no arxiv ids.

const ARXIV_RE = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)(\d{4}\.\d{4,5})/i;
export function docArxiv(d: { body?: string; arxiv?: string }): string | null {
  if ((d as any).arxiv) return (d as any).arxiv;
  const m = (d.body || "").match(ARXIV_RE) || (d.body || "").match(/\b(\d{4}\.\d{4,5})\b/);
  return m ? m[1] : null;
}

async function s2batch(arxivs: string[], fields: string): Promise<any[]> {
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/batch?fields=${fields}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: arxivs.map((a) => "ARXIV:" + a) }),
  });
  if (!r.ok) throw new Error("S2 " + r.status);
  return r.json();
}
// cached + resumable: S2 rate-limits, so we never re-fetch a paper.
async function s2fetch(arxivs: string[], fields: string, cacheFile?: string): Promise<Record<string, any>> {
  const cache: Record<string, any> = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const need = arxivs.filter((a) => !(a in cache));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100); let res: any[] | undefined;
    for (let t = 0; t < 5 && !res; t++) { try { res = await s2batch(chunk, fields); } catch { await new Promise((r) => setTimeout(r, 2500 * (t + 1))); } }
    (res || []).forEach((p, j) => { cache[chunk[j]] = p || null; });
    if (cacheFile) writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return cache;
}

export type FrontierPaper = { title: string; arxiv: string | null; n: number };
export type Frontier = { cite: number[][]; citec: number[]; ranked: FrontierPaper[]; corpusArxiv: number };

// (1) edges + (2) impact + (3) ranked external frontier
export async function fetchFrontier(docs: Doc[], opts: { cacheFile?: string } = {}): Promise<Frontier> {
  const arx = new Map<number, string>();
  docs.forEach((d, i) => { const a = docArxiv(d); if (a) arx.set(i, a); });
  const arxivToIdx = new Map<string, number>(); arx.forEach((a, i) => arxivToIdx.set(a, i));
  const cite: number[][] = docs.map(() => []); const citec = docs.map(() => 0);
  const ids = [...new Set(arx.values())];
  if (!ids.length) return { cite, citec, ranked: [], corpusArxiv: 0 }; // graceful no-op

  const cache = await s2fetch(ids, "title,citationCount,references.externalIds,references.title,citations.externalIds,citations.title", opts.cacheFile);
  const axId = (p: any) => (p && p.externalIds && p.externalIds.ArXiv) || null;
  const set = docs.map(() => new Set<number>());
  const front = new Map<string, FrontierPaper>();
  arx.forEach((a, i) => {
    const p = cache[a]; if (!p) return;
    citec[i] = p.citationCount || 0;
    for (const kind of ["references", "citations"] as const) for (const q of (p[kind] || [])) {
      const qa = axId(q);
      if (qa && arxivToIdx.has(qa)) { const j = arxivToIdx.get(qa)!; if (j !== i) { set[i].add(j); if (kind === "citations") set[j].add(i); } }
      else if (q && q.title) { const key = qa || q.title.toLowerCase().slice(0, 60); const e = front.get(key) || { title: q.title, arxiv: qa, n: 0 }; e.n++; front.set(key, e); }
    }
  });
  set.forEach((s, i) => (cite[i] = [...s]));
  const ranked = [...front.values()].filter((e) => e.title).sort((a, b) => b.n - a.n).slice(0, 500);
  return { cite, citec, ranked, corpusArxiv: ids.length };
}

export type Ghost = { title: string; arxiv: string; url: string; n: number; core: string; xy: [number, number]; sim: number };

// place the top-N frontier papers as ghost points: card into the same axes, embed, NN-place on the map
export async function buildGhosts(ranked: FrontierPaper[], axes: Axis[], mapXY: number[][], cardEmbs: number[][], opts: { topN?: number; cacheFile?: string } = {}): Promise<Ghost[]> {
  const cands = ranked.filter((f) => f.arxiv).slice(0, opts.topN ?? 60);
  if (!cands.length || !cardEmbs.length) return [];
  const absC = await s2fetch(cands.map((c) => c.arxiv!), "title,abstract", opts.cacheFile);
  const withAbs = cands.filter((c) => absC[c.arxiv!]?.abstract);
  if (!withAbs.length) return [];
  const asDocs: Doc[] = withAbs.map((c) => ({ id: c.arxiv!, title: c.title, body: `TITLE: ${c.title}\nABSTRACT: ${absC[c.arxiv!].abstract}` }));
  const deck = await cardCorpus(asDocs, axes, { concurrency: 8 });
  const embs = await getTextEmbeddings(deck.map((c) => ({ id: c.id, text: cardText(c, axes).slice(0, 1200) })));
  const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const CX = cardEmbs.map(unit);
  return deck.map((c, i) => {
    const e = unit(embs[i]);
    const sims = CX.map((v, j) => [j, v.reduce((s, x, k) => s + x * e[k], 0)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    let wx = 0, wy = 0, w = 0; for (const [j, s] of sims) { const ww = Math.max(0, s); wx += mapXY[j][0] * ww; wy += mapXY[j][1] * ww; w += ww; }
    const f = withAbs.find((x) => x.arxiv === c.id)!;
    return { title: c.title, arxiv: c.id, url: `https://arxiv.org/abs/${c.id}`, n: f.n, core: (c.core || "").slice(0, 200), xy: [+(wx / (w || 1)).toFixed(4), +(wy / (w || 1)).toFixed(4)] as [number, number], sim: +(sims[0]?.[1] ?? 0).toFixed(3) };
  });
}
