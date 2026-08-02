import { writeFileSync } from "node:fs";
import { discoverAxes, type Axis } from "./axes.ts";
import { cardCorpus, deckToJSONL, type Card } from "./card.ts";
import { embedCards, projectAndCluster, projectionScores } from "./map.ts";
import { nameLevels } from "./regions.ts";
import { provider } from "./provider.ts";
import { renderHTML, type MapData } from "./render.ts";
import { trajectory } from "./trajectory.ts";
import { buildReport } from "./report.ts";
import { fetchFrontier, buildGhosts } from "./frontier.ts";
import { loadFixture, type Doc } from "./corpus.ts";

// The full instrument, end to end: docs (+embeddings) -> discover axes -> card -> embed cards ->
// project + cluster -> name regions -> deck.jsonl + map-data.json + eidoscope.html.
export async function run(docs: Doc[], embeddings: number[][], opts: { frontier?: boolean; name?: string; embed?: "card" | "raw" } = {}) {
  const llm = provider();
  console.error(`\n[1/5] discovering axes from ${docs.length} docs…`);
  const { axes, realDims, projections } = await discoverAxes(embeddings, docs.map((d) => d.title.slice(0, 64)), { llm });
  console.error(`  ${axes.length} axes surfaced (${realDims} dims above the noise floor)`);
  if (docs.length < 50) console.error(`  ⚠ small corpus (${docs.length} docs) — PCA axes get noisy below ~50-100 docs; the variance % per axis will show it`);

  console.error(`[2/5] carding ${docs.length} docs over ${axes.length} axes…`);
  const conc = Number(process.env.EIDOSCOPE_CONCURRENCY || 48); // measured sweet spot (~8.7 cards/s; throughput collapses past ~64)
  const deck = await cardCorpus(docs, axes, { llm, concurrency: conc, cache: "." }); // cardCorpus prints its own two-phase progress
  writeFileSync("deck.jsonl", deckToJSONL(deck));
  console.error(`  ${deck.length} cards -> deck.jsonl`);

  // The map geometry comes from EITHER the cards (concept-bottleneck: restatement + placements as two
  // pooled vectors, the default) OR the raw full-text embeddings already computed for axis discovery
  // (--embed raw). Same axes, same cards for the reader/region-naming either way — only what the
  // layout+clusters are built on changes, a clean A/B on whether the card transformation helps this corpus.
  const useRaw = opts.embed === "raw";
  console.error(`[3/5] embedding ${useRaw ? "raw full text (no card bottleneck)" : "cards (restatement + placements)"} + projecting…`);
  const embs = useRaw ? embeddings : await embedCards(deck, axes);
  const { xy, xyz, cluster, k, di, levels, counts, hub, nbr } = await projectAndCluster(embs);

  // Name EVERY grain level contrastively — the deterministic layer computes what makes each region
  // distinct (over-used terms + extreme axes), the LLM only phrases it. Deduped across levels + cached.
  console.error(`[4/5] naming regions across ${counts.length} grain levels (${counts.join("·")}; default ${k})…`);
  const scores = projectionScores(projections, axes);
  const axLite = axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high }));
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(
    levels, counts, deck.map((c) => c.title), deck.map((c) => c.core), scores, axLite, { llm, concurrency: conc, cache: "." });
  // default-grain regions carry an on-map centroid (median position) for the label + legend
  const dGroups: number[][] = Array.from({ length: k }, () => []);
  cluster.forEach((c, i) => dGroups[c].push(i));
  const clusters = regionsByLevel[di].map((r, c) => {
    const g = dGroups[c] || []; const xs = g.map((i) => xy[i][0]).sort((a, b) => a - b), ys = g.map((i) => xy[i][1]).sort((a, b) => a - b);
    return { c: r.c, n: r.n, label: r.label, cx: xs[xs.length >> 1] || 0, cy: ys[ys.length >> 1] || 0 };
  });

  console.error(`[5/5] assembling map + rendering…`);
  const D: MapData = {
    ids: deck.map((c) => c.id), titles: deck.map((c) => c.title), cores: deck.map((c) => c.core),
    notes: deck.map((c) => Object.fromEntries(axes.map((a) => [a.key, c.axes[a.key]?.note || ""]))),
    axes: axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high, variance: a.var })),
    scores,
    xy, xyz, cluster, k, di, hub, nbr, clusters, levels, counts, levelLabels, levelBlurbs,
    urls: deck.map((c) => c.url || (c.path ? "file://" + c.path : undefined)),
    authors: deck.map((c) => c.author), tags: deck.map((c) => c.tags), dates: deck.map((c) => c.date),
    read: deck.map((c) => (c.readProgress != null ? c.readProgress > 0.05 : undefined)),
  };
  // Positions ARE the deterministic PCA projection (see `scores` above) — the LLM no longer scores
  // anything, so there's no fidelity proxy to police. Honesty is now the variance each axis explains:
  // a "minor" axis (<2%) is a real but thin direction — surfaced, flagged, and its % shown in the report.
  // (Parallel analysis keeps far more PCs than we surface, so gate on variance, not the dim count.)
  D.axes.forEach((a, i) => { a.weak = axes[i].var < 0.02; });
  const weak = D.axes.filter((a) => a.weak).length;
  console.error(`  ${D.axes.length - weak}/${D.axes.length} main axes (>=2% variance)${weak ? ` · ${weak} minor` : ""}`);
  if (opts.frontier) {
    console.error(`[frontier] telescope — Semantic Scholar citations…`);
    const fr = await fetchFrontier(docs, { cacheFile: "s2-cache.json" });
    D.cite = fr.cite; D.citec = fr.citec;
    if (fr.corpusArxiv) {
      const nEdges = fr.cite.reduce((a, e) => a + e.length, 0);
      D.ghosts = await buildGhosts(fr.ranked, D.axes.map((a) => ({ pc: 0, var: 0, coherence: 5, key: a.key, name: a.name, pole_low: a.low, pole_high: a.high })), xy, embs, { topN: 80, cacheFile: "s2-abs-cache.json" });
      console.error(`  ${fr.corpusArxiv} arxiv docs · ${nEdges} citation edges · ${fr.ranked.length} frontier papers · ${D.ghosts.length} ghosts placed`);
    } else console.error(`  no arxiv ids in corpus — frontier skipped (clean no-op)`);
  }
  writeFileSync("map-data.json", JSON.stringify(D));
  writeFileSync("eidoscope.html", renderHTML(D));
  const state = trajectory({ dates: deck.map((c) => c.date), cluster: D.cluster, scores: D.scores, axes: D.axes, clusters });
  if (state) writeFileSync("STATE.md", state);
  writeFileSync("REPORT.md", buildReport(D, opts.name || "Corpus"));
  console.error(`\n✅ ${deck.length} cards · ${axes.length} axes · ${k} regions`);
  console.error(`   → open  eidoscope.html   (the interactive map)`);
  console.error(`   → read  REPORT.md        (the shareable summary${state ? " + STATE.md trajectory" : ""})`);
  console.error(`   → data  deck.jsonl · map-data.json`);
  return D;
}

// Re-name an existing map WITHOUT re-carding or re-projecting. The geometry (xy, the grain ladder) and
// the cards are deterministic and already on disk; only the LLM labels drift. So relabeling is cheap and
// idempotent-ish: recompute every level's region names (contrastively) from the stored cores + scores,
// rebuild the default-grain regions, and hand back an updated map to re-render. This is the "cache the
// geometry, rename as needed" path — the labels are the one nondeterministic thing, kept out of the geometry.
export async function relabelMap(D: MapData, opts: { llm?: any; concurrency?: number; cacheDir?: string } = {}): Promise<MapData> {
  const llm = opts.llm ?? provider();
  const conc = opts.concurrency ?? Number(process.env.EIDOSCOPE_CONCURRENCY || 24);
  const levels = D.levels ?? [D.cluster], counts = D.counts ?? [D.k];
  let di = 0, best = Infinity; counts.forEach((c, i) => { const d = Math.abs(c - 18); if (d < best) { best = d; di = i; } }); // same default-grain rule as projectAndCluster
  const axLite = D.axes.map((a) => ({ key: a.key, name: a.name, low: a.low, high: a.high }));
  console.error(`relabeling ${counts.length} grain levels (${counts.join("·")}; default ${counts[di]})…`);
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(levels, counts, D.titles, D.cores, D.scores, axLite, { llm, concurrency: conc, cache: opts.cacheDir });
  const cluster = levels[di], k = counts[di];
  const dGroups: number[][] = Array.from({ length: k }, () => []); cluster.forEach((c, i) => dGroups[c].push(i));
  const clusters = regionsByLevel[di].map((r, c) => {
    const g = dGroups[c] || []; const xs = g.map((i) => D.xy[i][0]).sort((a, b) => a - b), ys = g.map((i) => D.xy[i][1]).sort((a, b) => a - b);
    return { c: r.c, n: r.n, label: r.label, cx: xs[xs.length >> 1] || 0, cy: ys[ys.length >> 1] || 0 };
  });
  return { ...D, cluster, k, di, clusters, levels, counts, levelLabels, levelBlurbs };
}

if (import.meta.main) {
  const { docs, embeddings } = loadFixture();
  await run(docs, embeddings);
}
