import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { discoverAxes, type Axis } from "./axes.ts";
import { cardCorpus, deckToJSONL, type Card } from "./card.ts";
import { embedCards, projectAndCluster, projectionScores, rawProjectionScores, buildMetaFields } from "./map.ts";
import { nameLevels } from "./regions.ts";
import { provider } from "./provider.ts";
import { singlefileHTML } from "./singlefile.ts";
import { trajectory } from "./trajectory.ts";
import { buildReport } from "./report.ts";
import { fetchFrontier, buildGhosts } from "./frontier.ts";
import { CFG, cachePath, cacheRoot } from "./config.ts";
import { encodeMap } from "./mapbin.ts";
import { type MapContract } from "./schema.ts";
import { loadFixture, type Doc } from "./corpus.ts";

// The full instrument, end to end: docs (+embeddings) -> discover axes -> card -> embed cards ->
// project + cluster -> name regions -> deck.jsonl + map-data.json + <slug>.eido + <slug>.html (self-contained viewer).
export async function run(docs: Doc[], embeddings: number[][], opts: { frontier?: boolean; name?: string; source?: string; embed?: "card" | "raw"; out?: string; debugJson?: boolean } = {}) {
  const llm = provider();
  // Every corpus gets its OWN self-describing output directory + `<slug>.eido` — the .eido is a portable,
  // addressable L-space you hand around, so mapping two corpora must never clobber a shared `map.eido`.
  const slug = (opts.name || "corpus").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "corpus";
  const outDir = opts.out || join("out", slug);
  mkdirSync(outDir, { recursive: true });
  const eidoName = slug + ".eido";
  console.error(`\n[1/5] discovering axes from ${docs.length} docs…`);
  const { axes, realDims, projections } = await discoverAxes(embeddings, docs.map((d) => d.title.slice(0, 64)), { llm });
  console.error(`  ${axes.length} axes surfaced (${realDims} dims above the noise floor)`);
  if (docs.length < 50) console.error(`  ⚠ small corpus (${docs.length} docs) — PCA axes get noisy below ~50-100 docs; the variance % per axis will show it`);

  console.error(`[2/5] carding ${docs.length} docs over ${axes.length} axes…`);
  const conc = Number(process.env.EIDOSCOPE_CONCURRENCY || 48); // measured sweet spot (~8.7 cards/s; throughput collapses past ~64)
  const deck = await cardCorpus(docs, axes, { llm, concurrency: conc, cache: cacheRoot() }); // cardCorpus prints its own two-phase progress
  writeFileSync(join(outDir, "deck.jsonl"), deckToJSONL(deck));
  console.error(`  ${deck.length} cards -> ${join(outDir, "deck.jsonl")}`);

  // The map geometry comes from EITHER the cards (concept-bottleneck: restatement + placements as two
  // pooled vectors, the default) OR the raw full-text embeddings already computed for axis discovery
  // (--embed raw). Same axes, same cards for the reader/region-naming either way — only what the
  // layout+clusters are built on changes, a clean A/B on whether the card transformation helps this corpus.
  const useRaw = opts.embed === "raw";
  console.error(`[3/5] embedding ${useRaw ? "raw full text (no card bottleneck)" : "cards (restatement + placements)"} + projecting…`);
  // Geometry must be built over the SAME set as identity (the deck). cardCorpus drops docs whose card
  // failed, so `deck` can be shorter than `docs`/`embeddings` — align the raw embeddings to the deck by
  // id (else xy/cluster get the dropped doc's row and every node-indexed array is off by one).
  const embOfId = useRaw ? new Map(docs.map((d, i) => [d.id, embeddings[i]])) : null;
  const embs = useRaw ? deck.map((c) => embOfId!.get(c.id)!) : await embedCards(deck, axes);
  // The axis projections were computed over ALL docs (axis discovery runs before carding) — align them
  // to the deck by id too, or a single failed card shifts every scores row after it (emit invariant
  // catches the length; without it every downstream array would be silently off by one). Bug found by
  // the invariant on the tldr corpus: 1 failed card of 6261 → scores.length 6261 vs ids.length 6260.
  const projOfId = new Map(docs.map((d, i) => [d.id, projections[i]]));
  const deckProjections = deck.map((c) => projOfId.get(c.id)!);
  const { xy, xyz, cluster, k, di, levels, counts, hub, nbr } = await projectAndCluster(embs);

  // Name EVERY grain level contrastively — the deterministic layer computes what makes each region
  // distinct (over-used terms + extreme axes), the LLM only phrases it. Deduped across levels + cached.
  console.error(`[4/5] naming regions across ${counts.length} grain levels (${counts.join("·")}; default ${k})…`);
  const scores = projectionScores(deckProjections, axes);
  const rawScores = rawProjectionScores(deckProjections, axes);   // true-magnitude coords → viewer "honest" axis toggle
  const axLite = axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high }));
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(
    levels, counts, deck.map((c) => c.title), deck.map((c) => c.core), scores, axLite, { llm, concurrency: conc, cache: cacheRoot() });
  // default-grain regions carry an on-map centroid (median position) for the label + legend
  const dGroups: number[][] = Array.from({ length: k }, () => []);
  cluster.forEach((c, i) => dGroups[c].push(i));
  const clusters = regionsByLevel[di].map((r, c) => {
    const g = dGroups[c] || []; const xs = g.map((i) => xy[i][0]).sort((a, b) => a - b), ys = g.map((i) => xy[i][1]).sort((a, b) => a - b);
    return { c: r.c, n: r.n, label: r.label, cx: xs[xs.length >> 1] || 0, cy: ys[ys.length >> 1] || 0 };
  });

  console.error(`[5/5] assembling map + rendering…`);
  const D: MapContract = {
    ids: deck.map((c) => c.id), titles: deck.map((c) => c.title), cores: deck.map((c) => c.core),
    notes: deck.map((c) => Object.fromEntries(axes.map((a) => [a.key, c.axes[a.key]?.note || ""]))),
    axes: axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high, variance: a.var })),
    scores, rawScores,
    xy, xyz, cluster, k, di, hub, nbr, clusters, levels, counts, levelLabels, levelBlurbs,
    urls: deck.map((c) => c.url || (c.path ? "file://" + c.path : undefined)),
    // parent-directory facet, carried explicitly (docs with web urls would otherwise lose it — schema.ts)
    folders: deck.map((c) => { const p = (c.path || "").split("/").filter(Boolean); return p.length >= 2 ? p[p.length - 2].replace(/_/g, " ") : undefined; }),
    sources: deck.map((c) => c.source), siteNames: deck.map((c) => c.siteName),
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
    const fr = await fetchFrontier(docs, { cacheFile: cachePath("s2-cache.json") });
    D.cite = fr.cite; D.citec = fr.citec;
    if (fr.corpusArxiv) {
      const nEdges = fr.cite.reduce((a, e) => a + e.length, 0);
      D.ghosts = await buildGhosts(fr.ranked, D.axes.map((a) => ({ pc: 0, var: 0, coherence: 5, key: a.key, name: a.name, pole_low: a.low, pole_high: a.high })), xy, embs, { topN: 80, cacheFile: cachePath("s2-abs-cache.json") });
      console.error(`  ${fr.corpusArxiv} arxiv docs · ${nEdges} citation edges · ${fr.ranked.length} frontier papers · ${D.ghosts.length} ghosts placed`);
    } else console.error(`  no arxiv ids in corpus — frontier skipped (clean no-op)`);
  }
  // every node-indexed array must have exactly one entry per card — fail loud, never emit a broken map
  const nNodes = D.ids.length;
  for (const [name, arr] of ([["titles", D.titles], ["cores", D.cores], ["notes", D.notes], ["xy", D.xy], ["xyz", D.xyz], ["cluster", D.cluster], ["hub", D.hub], ["nbr", D.nbr]] as [string, unknown[]][]))
    if (arr.length !== nNodes) throw new Error(`emit invariant violated: ${name}.length=${arr.length} != ids.length=${nNodes} (a node-indexed array is misaligned)`);
  for (const key of Object.keys(D.scores)) if (D.scores[key].length !== nNodes) throw new Error(`emit invariant violated: scores.${key}.length=${D.scores[key].length} != ids.length=${nNodes}`);
  // provenance — so a passed-around file introduces itself (what corpus, from where, when, how big)
  D.provenance = { title: opts.name || "Corpus", source: opts.source, generated: Date.now(), count: D.ids.length };
  // v2: carry the card vectors (the re-interrogation substrate) + how the map was made. `embs` is exactly
  // what the layout was built on (card vectors by default, raw full-text under --embed raw), aligned to the
  // deck; geometryBasis records which — so the file can't misrepresent whether it went through the bottleneck.
  if (embs?.length === nNodes) D.vectors = embs;
  D.derivedBy = {
    cardModel: CFG.model,
    embedder: { id: CFG.embedModel, dim: embs?.[0]?.length ?? 0, pooling: "mean", normalized: true },
    geometryBasis: useRaw ? "raw" : "card",
    generated: Date.now(),
  };
  D.metaFields = buildMetaFields(D);   // typed dimension manifest for the channel grammar
  // map-data.json is a DEBUG artifact: one JSON.stringify of the entire contract (including the card
  // vectors), which blows past the string length limit and crashes the run somewhere near 100k docs —
  // right where you most want the map. The .eido below is the real output and is ~5x smaller, so the
  // JSON is opt-in behind --debug-json and default runs skip it entirely.
  if (opts.debugJson) writeFileSync(join(outDir, "map-data.json"), JSON.stringify(D));
  const enc = encodeMap(D);
  writeFileSync(join(outDir, eidoName), enc);   // the portable artifact (~5× smaller)
  // self-contained offline explorer = the built Svelte+deck viewer with this .eido inlined (one HTML, no server)
  const htmlName = slug + ".html", html = singlefileHTML(enc);
  if (html) writeFileSync(join(outDir, htmlName), html);
  else console.error("  ⚠ viewer not built — skipped the self-contained HTML (run `cd viewer && bun run build`); the .eido still opens in the viewer");
  const state = trajectory({ dates: deck.map((c) => c.date), cluster: D.cluster, scores: D.scores, axes: D.axes, clusters });
  if (state) writeFileSync(join(outDir, "STATE.md"), state);
  writeFileSync(join(outDir, "REPORT.md"), buildReport(D, opts.name || "Corpus"));
  console.error(`\n✅ ${deck.length} cards · ${axes.length} axes · ${k} regions  →  ${outDir}/`);
  console.error(`   → map   ${join(outDir, eidoName)}   (the portable L-space; open in the viewer)`);
  if (html) console.error(`   → open  ${join(outDir, htmlName)}   (self-contained interactive explorer)`);
  console.error(`   → read  ${join(outDir, "REPORT.md")}        (shareable summary${state ? " + STATE.md trajectory" : ""})`);
  console.error(`   → data  ${join(outDir, "deck.jsonl")}${opts.debugJson ? ` · ${join(outDir, "map-data.json")}` : ""}`);
  return D;
}

// Re-name an existing map WITHOUT re-carding or re-projecting. The geometry (xy, the grain ladder) and
// the cards are deterministic and already on disk; only the LLM labels drift. So relabeling is cheap and
// idempotent-ish: recompute every level's region names (contrastively) from the stored cores + scores,
// rebuild the default-grain regions, and hand back an updated map to re-render. This is the "cache the
// geometry, rename as needed" path — the labels are the one nondeterministic thing, kept out of the geometry.
export async function relabelMap(D: MapContract, opts: { llm?: any; sig?: any; concurrency?: number; cacheDir?: string; quiet?: boolean } = {}): Promise<MapContract> {
  const llm = opts.llm ?? provider();
  const conc = opts.concurrency ?? Number(process.env.EIDOSCOPE_CONCURRENCY || 24);
  const levels = D.levels ?? [D.cluster], counts = D.counts ?? [D.k];
  let di = 0, best = Infinity; counts.forEach((c, i) => { const d = Math.abs(c - 18); if (d < best) { best = d; di = i; } }); // same default-grain rule as projectAndCluster
  const axLite = D.axes.map((a) => ({ key: a.key, name: a.name, low: a.low, high: a.high }));
  if (!opts.quiet) console.error(`relabeling ${counts.length} grain levels (${counts.join("·")}; default ${counts[di]})…`);
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(levels, counts, D.titles, D.cores, D.scores, axLite, { llm, sig: opts.sig, concurrency: conc, cache: opts.cacheDir });
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
