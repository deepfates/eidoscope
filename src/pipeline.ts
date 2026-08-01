import { writeFileSync } from "node:fs";
import { discoverAxes, type Axis } from "./axes.ts";
import { cardCorpus, deckToJSONL, type Card } from "./card.ts";
import { embedCards, projectAndCluster, projectionScores } from "./map.ts";
import { nameCluster } from "./signatures.ts";
import { provider } from "./provider.ts";
import { renderHTML, type MapData } from "./render.ts";
import { trajectory } from "./trajectory.ts";
import { scoreRedundancy } from "./redundancy.ts";
import { buildReport } from "./report.ts";
import { fetchFrontier, buildGhosts } from "./frontier.ts";
import { loadFixture, type Doc } from "./corpus.ts";

// The full instrument, end to end: docs (+embeddings) -> discover axes -> card -> embed cards ->
// project + cluster -> name regions -> deck.jsonl + map-data.json + eidoscope.html.
export async function run(docs: Doc[], embeddings: number[][], opts: { frontier?: boolean; name?: string } = {}) {
  const llm = provider();
  console.error(`\n[1/5] discovering axes from ${docs.length} docs…`);
  const { axes, realDims, projections } = await discoverAxes(embeddings, docs.map((d) => d.title.slice(0, 64)), { llm });
  console.error(`  ${axes.length} crisp axes (${realDims} real dims)`);
  if (docs.length < 50) console.error(`  ⚠ small corpus (${docs.length} docs) — PCA axes get noisy below ~50-100 docs; the distinctness guard below will show it`);

  console.error(`[2/5] carding ${docs.length} docs over ${axes.length} axes…`);
  let n = 0;
  const conc = Number(process.env.EIDOSCOPE_CONCURRENCY || 24); // the card reads dominate wall-clock; raise for faster cloud runs
  const deck = await cardCorpus(docs, axes, { llm, concurrency: conc, cache: "deck-cache.jsonl", onProgress: (d) => { if (++n % 100 === 0) process.stderr.write(`  ${n}/${docs.length}\r`); } });
  writeFileSync("deck.jsonl", deckToJSONL(deck));
  console.error(`  ${deck.length} cards -> deck.jsonl`);

  console.error(`[3/5] embedding cards + projecting…`);
  const embs = await embedCards(deck, axes);
  const { xy, xyz, cluster, k, hub, nbr } = await projectAndCluster(embs);

  console.error(`[4/5] naming ${k} regions…`);
  const groups: number[][] = Array.from({ length: k }, () => []);
  cluster.forEach((c, i) => groups[c].push(i));
  const clusters = await Promise.all(groups.map(async (g, c) => {
    const samples = g.slice(0, 12).map((i) => `${deck[i].title} — ${deck[i].core}`.slice(0, 220)).join("\n\n");
    let r: any = { regionLabel: `region ${c}` }; try { r = await nameCluster.forward(llm, { memberSamples: samples }); } catch {}
    const xs = g.map((i) => xy[i][0]).sort((a, b) => a - b), ys = g.map((i) => xy[i][1]).sort((a, b) => a - b);
    return { c, n: g.length, label: r.regionLabel, cx: xs[xs.length >> 1] || 0, cy: ys[ys.length >> 1] || 0 };
  }));

  console.error(`[5/5] assembling map + rendering…`);
  const D: MapData = {
    ids: deck.map((c) => c.id), titles: deck.map((c) => c.title), cores: deck.map((c) => c.core),
    notes: deck.map((c) => Object.fromEntries(axes.map((a) => [a.key, c.axes[a.key]?.note || ""]))),
    axes: axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high })),
    scores: projectionScores(projections, axes),
    xy, xyz, cluster, k, hub, nbr, clusters,
    urls: deck.map((c) => c.url || (c.path ? "file://" + c.path : undefined)),
    authors: deck.map((c) => c.author), tags: deck.map((c) => c.tags), dates: deck.map((c) => c.date),
    read: deck.map((c) => (c.readProgress != null ? c.readProgress > 0.05 : undefined)),
  };
  // Positions ARE the deterministic PCA projection (see `scores` above) — the LLM no longer scores
  // anything. Honesty is now structural, not a proxy: an axis is trustworthy iff parallel analysis
  // kept it (pc <= realDims). No fidelity guard, no gate — there is no LLM score left to police.
  D.axes.forEach((a, i) => { a.weak = axes[i].pc > realDims; });
  const weak = D.axes.filter((a) => a.weak).length;
  const rg = scoreRedundancy(D.scores);
  console.error(`  ${D.axes.length - weak}/${D.axes.length} axes above the noise floor (parallel analysis)${weak ? ` · ${weak} weak` : ""}  ·  distinctness mean|r| ${rg.meanAbsR.toFixed(2)} ${rg.pass ? "✓" : `⚠ ${rg.strong} redundant pairs`}`);
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

if (import.meta.main) {
  const { docs, embeddings } = loadFixture();
  await run(docs, embeddings);
}
