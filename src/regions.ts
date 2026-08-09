import { nameCluster } from "./signatures.ts";
import { hash, Store, pool, withRetry } from "./llm.ts";

// Naming regions the GRUG way: the model does not guess what a region is "about" from a pile of its
// members — the deterministic layer first COMPUTES what makes the region distinct (terms it over-uses
// vs the rest of the corpus; axes it sits at an extreme on), and the model only phrases that contrast.
// This is what kills the "everything is Hazards" collision: a token frequent everywhere has a low
// distinctiveness ratio, so it never surfaces as the headline. Math finds the contrast; the LLM labels it.
//
// HOST-FREE (eid-bacg): llm injected by the caller, cache an injected Store (file-backed in node,
// session memory in the page), progress a callback — same seams as cardCorpus.

export type Region = { c: number; n: number; label: string; blurb: string; terms: string[] };

// The math that finds the contrast lives in distinct.ts — ONE implementation, shared with the viewer
// (a held Selection explains itself with exactly these two functions). Re-exported so existing callers
// and tests that import them from here keep working.
export { distinctiveTerms, distinctiveAxes } from "./distinct.ts";
import { distinctiveTerms, distinctiveAxes } from "./distinct.ts";

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
  opts: { llm?: any; sig?: any; concurrency?: number; cache?: Store; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ labels: string[][]; blurbs: string[][]; regionsByLevel: Region[][] }> {
  const llm = opts.llm;
  if (llm === undefined) throw new Error("nameLevels: an llm client is required (the caller injects it)");
  const sig = opts.sig ?? nameCluster;
  const conc = opts.concurrency ?? 12;
  const store = opts.cache ?? new Store();

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
  const progress = opts.onProgress ?? ((dn: number, total: number) => { if (total && (dn % 25 === 0 || dn === total)) (globalThis as any).process?.stderr?.write?.(`  regions ${dn}/${total}\r`); });
  await pool(todo, async (j) => {
    const ck = hash("name2 " + j.terms.join(",") + " | " + j.axesTxt + " | " + j.samples);
    let v = store.get(ck);
    if (!v) {
      const r: any = await withRetry(() => sig.forward(llm, { distinctiveTerms: j.terms.join(", ") || "(none stand out)", distinctiveAxes: j.axesTxt || "(none extreme)", memberSamples: j.samples }));
      if (r?.regionLabel) { v = { label: String(r.regionLabel), blurb: String(r.regionBlurb ?? "") }; store.put(ck, v); }
      else fail++;
    }
    if (v) named.set(j.key, v);
    progress(++done, todo.length);
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
