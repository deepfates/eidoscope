import { nameCluster } from "./signatures.ts";
import { provider } from "./provider.ts";
import { hash, Store, pool, withRetry } from "./llm.ts";
import { join } from "node:path";

// Naming regions the GRUG way: the model does not guess what a region is "about" from a pile of its
// members — the deterministic layer first COMPUTES what makes the region distinct (terms it over-uses
// vs the rest of the corpus; axes it sits at an extreme on), and the model only phrases that contrast.
// This is what kills the "everything is Hazards" collision: a token frequent everywhere has a low
// distinctiveness ratio, so it never surfaces as the headline. Math finds the contrast; the LLM labels it.

export type Region = { c: number; n: number; label: string; blurb: string; terms: string[] };

// A small, generic english stoplist. Deliberately NOT domain-specific: we don't hardcode "spell/feat/
// effect" as stopwords, because letting the data decide (via the corpus-frequency filter below) is the
// honest move — a domain term that's genuinely everywhere gets dropped by its own high document frequency.
const STOP = new Set("the a an and or of to in on for with without from by as at into is are be was were been being it its this that these those you your they them their he she his her we our us i me my not no do does did can could would should may might must will shall have has had having if then than so such but nor only own same too very can't don't more most other some any each few all both then once here there when where why how what which who whom whose against between through during before after above below up down out off over under again further".split(/\s+/));

const tokenize = (s: string): string[] => (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w));

// tf-idf-style distinctive terms: for each group, the terms whose rate INSIDE the group most exceeds
// their rate across the whole corpus (log-ratio), requiring the term to appear in several member docs
// so a single doc's jargon can't headline a region. Terms that are common corpus-wide are filtered out
// up front by document frequency — that is the mechanism that suppresses globally-frequent tokens.
export function distinctiveTerms(cores: string[], groups: number[][], opts: { top?: number; minDocs?: number; maxDf?: number } = {}): string[][] {
  const top = opts.top ?? 8, minDocs = opts.minDocs ?? 2, maxDf = opts.maxDf ?? 0.6;
  const N = cores.length;
  const docToks: Map<string, number>[] = cores.map((c) => { const m = new Map<string, number>(); for (const t of tokenize(c)) m.set(t, (m.get(t) || 0) + 1); return m; });
  // corpus totals + document frequency
  const corpusCnt = new Map<string, number>(); const df = new Map<string, number>(); let corpusTot = 0;
  for (const m of docToks) for (const [t, c] of m) { corpusCnt.set(t, (corpusCnt.get(t) || 0) + c); corpusTot += c; df.set(t, (df.get(t) || 0) + 1); }
  const dfCut = maxDf * N;
  return groups.map((idx) => {
    const cnt = new Map<string, number>(); const inDocs = new Map<string, number>(); let tot = 0;
    for (const i of idx) for (const [t, c] of docToks[i] || []) { cnt.set(t, (cnt.get(t) || 0) + c); tot += c; inDocs.set(t, (inDocs.get(t) || 0) + 1); }
    if (!tot) return [];
    const scored: [string, number][] = [];
    for (const [t, c] of cnt) {
      const docs = inDocs.get(t) || 0;
      if (docs < Math.min(minDocs, idx.length) || (df.get(t) || 0) > dfCut) continue;
      const pIn = c / tot, pAll = (corpusCnt.get(t) || 1) / corpusTot;
      // log-ratio (distinctive vs corpus) weighted by COVERAGE — how many of the region's docs use the term,
      // NOT raw count. So a term hammered by one doc (distinctive but narrow, e.g. a class-specific word) can't
      // headline a broad region; a lead term must be both distinctive AND spread across the region's members.
      scored.push([t, Math.log(pIn / pAll) * Math.log(1 + docs)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, top).map(([t]) => t);
  });
}

// Distinctive axes: where a group's mean position (rank-normalized 0-100, so the corpus mean is 50)
// departs most from center, ranked by |dev|, with the pole it leans toward. Ties the name to the
// interpretable axes for free — the region is described in the same language as the rest of the tool.
export function distinctiveAxes(scores: Record<string, number[]>, axes: { key: string; name: string; low: string; high: string }[], idx: number[], topN = 4): { name: string; pole: string; mean: number }[] {
  return axes.map((a) => {
    const col = scores[a.key] || []; let s = 0; for (const i of idx) s += col[i] ?? 50;
    const mean = idx.length ? s / idx.length : 50;
    return { name: a.name, pole: mean >= 50 ? a.high : a.low, mean: Math.round(mean), dev: Math.abs(mean - 50) };
  }).sort((x, y) => y.dev - x.dev).slice(0, topN).map(({ name, pole, mean }) => ({ name, pole, mean }));
}

// A cheap, stable signature of a member set, so a cluster that persists UNCHANGED across adjacent grain
// levels is named once, not once per level. Order-independent (xor-fold of ids) + size, so nested
// snapshots that share the same members share the same key.
const memberKey = (idx: number[]) => { let x = 0 >>> 0; for (const i of idx) x = (x ^ (Math.imul(i + 1, 2654435761) >>> 0)) >>> 0; return idx.length + ":" + x.toString(36); };

const groupsOf = (assign: number[], count: number): number[][] => { const g: number[][] = Array.from({ length: count }, () => []); assign.forEach((c, i) => { if (c >= 0 && c < count) g[c].push(i); }); return g; };

const sampleText = (idx: number[], titles: string[], cores: string[], n = 12) => idx.slice(0, n).map((i) => `${titles[i]} — ${cores[i]}`.slice(0, 220)).join("\n\n");

// Name EVERY grain level's regions contrastively, deduping member-sets that repeat across levels and
// caching by content so re-runs are free. Returns a label+blurb per cluster per level, plus a rich
// Region[] for the default level (with centroids the caller fills in).
export async function nameLevels(
  levels: number[][], counts: number[], titles: string[], cores: string[],
  scores: Record<string, number[]>, axes: { key: string; name: string; low: string; high: string }[],
  opts: { llm?: any; sig?: any; concurrency?: number; cache?: string } = {}
): Promise<{ labels: string[][]; blurbs: string[][]; regionsByLevel: Region[][] }> {
  const llm = opts.llm ?? provider();
  const sig = opts.sig ?? nameCluster;
  const conc = opts.concurrency ?? 12;
  const store = new Store(typeof opts.cache === "string" ? join(opts.cache, "region-cache.jsonl") : undefined);

  // gather every UNIQUE cluster across all levels, with its computed distinctiveness
  type Job = { key: string; idx: number[]; terms: string[]; axesTxt: string; samples: string };
  const jobs = new Map<string, Job>();
  const perLevel: { key: string; n: number; terms: string[] }[][] = levels.map((assign, L) => {
    const groups = groupsOf(assign, counts[L]);
    const terms = distinctiveTerms(cores, groups);
    return groups.map((idx, c) => {
      const key = memberKey(idx);
      if (idx.length && !jobs.has(key)) {
        const daxes = distinctiveAxes(scores, axes, idx);
        jobs.set(key, { key, idx, terms: terms[c], samples: sampleText(idx, titles, cores), axesTxt: daxes.map((a) => `${a.name}: toward ${a.pole} (${a.mean}/100)`).join("; ") });
      }
      return { key, n: idx.length, terms: terms[c] };
    });
  });

  // name each unique cluster once (cached, retried), math-computed contrast fed in as typed fields
  const named = new Map<string, { label: string; blurb: string }>();
  const todo = [...jobs.values()];
  let done = 0, fail = 0;
  const tick = () => { if (todo.length && (++done % 25 === 0 || done === todo.length)) process.stderr.write(`  regions ${done}/${todo.length}\r`); };
  await pool(todo, async (j) => {
    const ck = hash("name2 " + j.terms.join(",") + " | " + j.axesTxt + " | " + j.samples);
    let v = store.get(ck);
    if (!v) {
      const r: any = await withRetry(() => sig.forward(llm, { distinctiveTerms: j.terms.join(", ") || "(none stand out)", distinctiveAxes: j.axesTxt || "(none extreme)", memberSamples: j.samples }));
      if (r?.regionLabel) { v = { label: String(r.regionLabel), blurb: String(r.regionBlurb ?? "") }; store.put(ck, v); }
      else fail++;
    }
    if (v) named.set(j.key, v);
    tick();
  }, conc);
  if (fail) console.error(`  ⚠ ${fail} regions failed after retries (reported, not silently dropped)`);

  const fallback = (terms: string[]) => terms.slice(0, 2).map((t) => t[0].toUpperCase() + t.slice(1)).join(" / ") || "region";
  const labels: string[][] = [], blurbs: string[][] = [], regionsByLevel: Region[][] = [];
  perLevel.forEach((lvl) => {
    labels.push(lvl.map((g) => named.get(g.key)?.label || fallback(g.terms)));
    blurbs.push(lvl.map((g) => named.get(g.key)?.blurb || ""));
    regionsByLevel.push(lvl.map((g, c) => ({ c, n: g.n, label: named.get(g.key)?.label || fallback(g.terms), blurb: named.get(g.key)?.blurb || "", terms: g.terms })));
  });
  return { labels, blurbs, regionsByLevel };
}
