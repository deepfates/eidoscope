// WHAT MAKES A SET DISTINCT — the pure, dependency-free half of region naming, lifted out of regions.ts so
// the BROWSER can run it too. A held selection (viewer/SELECT) must explain itself in the same language the
// pipeline uses to name a region: the terms it over-uses vs the corpus, and the axes it leans on. One
// implementation, two callers — regions.ts re-exports these for the pipeline, the viewer imports them direct
// (no node builtins, no LLM, no I/O in this file — that is what makes it importable from viewer/src).

// A small, generic english stoplist. Deliberately NOT domain-specific: we don't hardcode "spell/feat/
// effect" as stopwords, because letting the data decide (via the corpus-frequency filter below) is the
// honest move — a domain term that's genuinely everywhere gets dropped by its own high document frequency.
const STOP = new Set("the a an and or of to in on for with without from by as at into is are be was were been being it its this that these those you your they them their he she his her we our us i me my not no do does did can could would should may might must will shall have has had having if then than so such but nor only own same too very can't don't more most other some any each few all both then once here there when where why how what which who whom whose against between through during before after above below up down out off over under again further".split(/\s+/));

export const tokenize = (s: string): string[] => (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w));

// tf-idf-style distinctive terms: for each group, the terms whose rate INSIDE the group most exceeds
// their rate across the whole corpus (log-ratio), requiring the term to appear in several member docs
// so a single doc's jargon can't headline a region. Terms that are common corpus-wide are filtered out
// up front by document frequency — that is the mechanism that suppresses globally-frequent tokens.
// The corpus half of the calculation: tokens per document, corpus counts, document frequency. It does
// not depend on WHICH set you are asking about, so it is built once per corpus and reused. Rebuilding
// it per call cost 600ms on every lasso of the 19,299-card pitchfork map — the whole corpus
// re-tokenised to explain 2,250 cards (measured 2026-08-11, walking the loop).
export type TermIndex = { docToks: Map<string, number>[]; corpusCnt: Map<string, number>; df: Map<string, number>; corpusTot: number; N: number };
export function buildTermIndex(cores: string[]): TermIndex {
  const docToks: Map<string, number>[] = cores.map((c) => { const m = new Map<string, number>(); for (const t of tokenize(c)) m.set(t, (m.get(t) || 0) + 1); return m; });
  const corpusCnt = new Map<string, number>(); const df = new Map<string, number>(); let corpusTot = 0;
  for (const m of docToks) for (const [t, c] of m) { corpusCnt.set(t, (corpusCnt.get(t) || 0) + c); corpusTot += c; df.set(t, (df.get(t) || 0) + 1); }
  return { docToks, corpusCnt, df, corpusTot, N: cores.length };
}

export function distinctiveTerms(cores: string[], groups: number[][], opts: { top?: number; minDocs?: number; maxDf?: number } = {}): string[][] {
  return distinctiveTermsFrom(buildTermIndex(cores), groups, opts);
}

export function distinctiveTermsFrom(ix: TermIndex, groups: number[][], opts: { top?: number; minDocs?: number; maxDf?: number } = {}): string[][] {
  const top = opts.top ?? 8, minDocs = opts.minDocs ?? 2, maxDf = opts.maxDf ?? 0.6;
  const { docToks, corpusCnt, df, corpusTot, N } = ix;
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
// interpretable axes for free — the group is described in the same language as the rest of the tool.
export function distinctiveAxes(scores: Record<string, number[]>, axes: { key: string; name: string; low: string; high: string }[], idx: number[], topN = 4): { name: string; pole: string; mean: number }[] {
  return axes.map((a) => {
    const col = scores[a.key] || []; let s = 0; for (const i of idx) s += col[i] ?? 50;
    const mean = idx.length ? s / idx.length : 50;
    return { name: a.name, pole: mean >= 50 ? a.high : a.low, mean: Math.round(mean), dev: Math.abs(mean - 50) };
  }).sort((x, y) => y.dev - x.dev).slice(0, topN).map(({ name, pole, mean }) => ({ name, pole, mean }));
}
