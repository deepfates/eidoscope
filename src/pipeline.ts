import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { discoverAxes, type Axis } from "./axes.ts";
import { deckToJSONL } from "./card.ts";
import { poolEmbed, projectAndCluster, projectionScores, rawProjectionScores, buildMetaFields, knnIndex, type Embedder } from "./map.ts";
import { poolEmbedWith } from "./geometry.ts";
import { getTextEmbeddings } from "./embed.ts";
import { nameLevels } from "./regions.ts";
import { provider } from "./provider.ts";
import { eidoSink, slugify } from "./sink.ts";
import { trajectory } from "./trajectory.ts";
import { buildReport } from "./report.ts";
import { fetchFrontier, buildGhosts } from "./frontier.ts";
import { llmUsageLine } from "./signatures.ts";
import { CFG, cachePath, cacheRoot, cacheStore, fileStore } from "./config.ts";
import { type MapContract } from "./schema.ts";
import { loadFixture, type Doc } from "./corpus.ts";
import { buildMap, regionCentroids, type EngineProgress } from "./engine.ts";

// The NODE FACE of the full instrument (the engine itself is host-free in src/engine.ts — the in-page
// ingest runs the SAME stages). run() binds the engine to this host: provider() from env, file-backed
// caches, hnswlib kNN, the local MiniLM, stderr narration — then emits the artifacts:
// deck.jsonl + <slug>.eido + <slug>.html (self-contained viewer) + REPORT.md (+ STATE.md).
export async function run(docs: Doc[], embeddings: number[][], opts: { frontier?: boolean; name?: string; source?: string; embed?: "card" | "raw"; out?: string; debugJson?: boolean; llm?: any; cardSig?: any; regionSig?: any; embedder?: Embedder; cacheDir?: string | null } = {}) {
  const llm = opts.llm ?? provider();
  // Every corpus gets its OWN self-describing output directory + `<slug>.eido` — the .eido is a portable,
  // addressable L-space you hand around, so mapping two corpora must never clobber a shared `map.eido`.
  const slug = slugify(opts.name);
  const outDir = opts.out || join("out", slug);
  mkdirSync(outDir, { recursive: true });
  const conc = Number(process.env.EIDOSCOPE_CONCURRENCY || 48); // measured sweet spot (~8.7 cards/s; throughput collapses past ~64)
  const useCache = opts.cacheDir !== null;
  const say = (s: string) => console.error(s);
  // stderr narration from the engine's honest progress stream — the CLI's face of the same events a UI shows
  const onProgress = (p: EngineProgress) => {
    if (p.stage === "axes") say(`\n[1/5] discovering axes from ${p.docs} docs…`);
    else if (p.stage === "axes-done") {
      say(`  ${p.axes} axes surfaced (${p.realDims} dims above the noise floor)`);
      if (docs.length < 50) say(`  ⚠ small corpus (${docs.length} docs) — PCA axes get noisy below ~50-100 docs; the variance % per axis will show it`);
      say(`[2/5] carding ${docs.length} docs over ${p.axes} axes…`);
    } else if (p.stage === "cards") { if (p.total && (p.done % 50 === 0 || p.done === p.total)) process.stderr.write(`  cards ${p.done}/${p.total}\r`); }
    else if (p.stage === "embed-cards") say(`[3/5] embedding cards (restatement + placements) + projecting…`);
    else if (p.stage === "layout") { if (opts.embed === "raw") say(`[3/5] embedding raw full text (no card bottleneck) + projecting…`); }
    else if (p.stage === "regions") { if (p.done === 1) say(`[4/5] naming regions…`); if (p.total && (p.done % 25 === 0 || p.done === p.total)) process.stderr.write(`  regions ${p.done}/${p.total}\r`); }
  };
  const { D, deck, axes, embs } = await buildMap(docs, embeddings, {
    llm, cardSig: opts.cardSig, regionSig: opts.regionSig, concurrency: conc, embed: opts.embed,
    // card-text embedding through the ONE chunk-pooling implementation (geometry.poolEmbedWith); the
    // disk cache is skipped under cacheDir:null (tests with injected fake embedders must not poison it)
    embedCardTexts: (texts) => (useCache
      ? poolEmbed(texts, cachePath("cache-eidoscope-cards"), { embed: opts.embedder })
      : poolEmbedWith(texts, (items) => (opts.embedder ?? getTextEmbeddings)(items, {}))),
    cardCache: useCache ? cacheStore("card-cache.jsonl") : undefined,
    regionCache: useCache ? cacheStore("region-cache.jsonl") : undefined,
    approxKnn: knnIndex,
    name: opts.name, source: opts.source,
    cardModel: CFG.model, embedderId: CFG.embedModel,
    onProgress,
  });
  writeFileSync(join(outDir, "deck.jsonl"), deckToJSONL(deck));
  say(`  ${deck.length} cards -> ${join(outDir, "deck.jsonl")}`);
  const weak = D.axes.filter((a) => a.weak).length;
  say(`  ${D.axes.length - weak}/${D.axes.length} main axes (>=2% variance)${weak ? ` · ${weak} minor` : ""}`);
  say(`[5/5] assembling map + rendering…`);
  if (opts.frontier) {
    say(`[frontier] telescope — Semantic Scholar citations…`);
    const fr = await fetchFrontier(docs, { cacheFile: cachePath("s2-cache.json") });
    D.cite = fr.cite; D.citec = fr.citec;
    if (fr.corpusArxiv) {
      const nEdges = fr.cite.reduce((a, e) => a + e.length, 0);
      D.ghosts = await buildGhosts(fr.ranked, D.axes.map((a) => ({ pc: 0, var: 0, coherence: 5, key: a.key, name: a.name, pole_low: a.low, pole_high: a.high })), D.xy, embs, { topN: 80, cacheFile: cachePath("s2-abs-cache.json"), llm });
      say(`  ${fr.corpusArxiv} arxiv docs · ${nEdges} citation edges · ${fr.ranked.length} frontier papers · ${D.ghosts.length} ghosts placed`);
    } else say(`  no arxiv ids in corpus — frontier skipped (clean no-op)`);
    D.metaFields = buildMetaFields(D);   // citec arrived after assembly — re-declare the manifest
  }
  // map-data.json is a DEBUG artifact: one JSON.stringify of the entire contract (including the card
  // vectors), which blows past the string length limit and crashes the run somewhere near 100k docs —
  // right where you most want the map. The .eido below is the real output and is ~5x smaller, so the
  // JSON is opt-in behind --debug-json and default runs skip it entirely.
  if (opts.debugJson) writeFileSync(join(outDir, "map-data.json"), JSON.stringify(D));
  // the map artifacts go out through the SINK seam (src/sink.ts): <slug>.eido + the self-contained HTML
  const emitted = eidoSink.emit(D, outDir, { slug });
  const eidoOut = emitted.find((f) => f.endsWith(".eido"))!, htmlOut = emitted.find((f) => f.endsWith(".html"));
  if (!htmlOut) say("  ⚠ viewer not built — skipped the self-contained HTML (run `cd viewer && bun run build`); the .eido still opens in the viewer");
  const state = trajectory({ dates: deck.map((c) => c.date), cluster: D.cluster, scores: D.scores, axes: D.axes, clusters: D.clusters });
  if (state) writeFileSync(join(outDir, "STATE.md"), state);
  const usage = llmUsageLine();   // measured across carding + axis labeling + region naming (signatures.ts)
  writeFileSync(join(outDir, "REPORT.md"), buildReport(D, opts.name || "Corpus", { usage }));
  say(`\n✅ ${deck.length} cards · ${axes.length} axes · ${D.k} regions  →  ${outDir}/`);
  say(`   ${usage}`);
  say(`   → map   ${eidoOut}   (the portable L-space; open in the viewer)`);
  if (htmlOut) say(`   → open  ${htmlOut}   (self-contained interactive explorer)`);
  say(`   → read  ${join(outDir, "REPORT.md")}        (shareable summary${state ? " + STATE.md trajectory" : ""})`);
  say(`   → data  ${join(outDir, "deck.jsonl")}${opts.debugJson ? ` · ${join(outDir, "map-data.json")}` : ""}`);
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
  const cache = typeof opts.cacheDir === "string" ? fileStore(join(opts.cacheDir, "region-cache.jsonl")) : undefined;
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(levels, counts, D.titles, D.cores, D.scores, axLite, { llm, sig: opts.sig, concurrency: conc, cache });
  const cluster = levels[di], k = counts[di];
  const clusters = regionCentroids(regionsByLevel[di], cluster, k, D.xy);
  return { ...D, cluster, k, di, clusters, levels, counts, levelLabels, levelBlurbs };
}

// DESCEND v0 (eid-nuwd) — re-map a held Selection as its OWN L-space, from a parent .eido alone.
// The .eido does NOT carry full text; the honest source it DOES carry is the per-card embedding
// vectors the parent's geometry was built on (card vectors by default, raw full-text under --embed
// raw — `derivedBy.geometryBasis` says which). So descend re-runs discovery (truncated PCA +
// parallel analysis) over the SUBSET of those carried vectors → NEW local axes, re-projects and
// re-clusters the subset, and re-names its regions. The cards themselves (titles/cores + metadata)
// are REUSED verbatim — no re-carding, no embedder, no full text needed. Two honest losses, stated
// here and in the child's provenance: (1) axes are discovered from the carried vectors, not from
// fresh full-text embeddings; (2) the per-axis placement notes were written against the PARENT's
// axes, so the child's cards carry no notes (positions on the new axes are exact projections).
export async function descendMap(P: MapContract, selIds: string[], opts: { llm?: any; sig?: any; name?: string; parentFile?: string; concurrency?: number; cacheDir?: string; quiet?: boolean } = {}): Promise<MapContract> {
  if (!P.vectors?.data?.length) throw new Error("descend: this .eido carries no card vectors (a lite emit) — nothing honest to re-discover from");
  const at = new Map(P.ids.map((id, i) => [id, i]));
  const missing = selIds.filter((id) => !at.has(id));
  if (missing.length) throw new Error(`descend: ${missing.length} selection id(s) not in the parent map (e.g. ${missing[0]})`);
  const idx = selIds.map((id) => at.get(id)!);
  if (idx.length < 2) throw new Error("descend: need at least 2 selected cards to discover local axes");
  const sub = <T>(a: T[] | undefined): T[] | undefined => (a ? idx.map((i) => a[i]) : undefined);
  // rows for discovery (PCA wants number[][]); the child re-emits them flat (schema CardVectors)
  const vdim = P.vectors.dim;
  const vectors = idx.map((i) => Array.from(P.vectors!.data.subarray(i * vdim, (i + 1) * vdim)));
  const titles = idx.map((i) => P.titles[i]), cores = idx.map((i) => P.cores[i]);
  const llm = opts.llm ?? provider();
  const conc = opts.concurrency ?? Number(process.env.EIDOSCOPE_CONCURRENCY || 24);

  if (!opts.quiet) console.error(`[1/3] descending: re-discovering axes over ${idx.length} of ${P.ids.length} cards…`);
  const { axes, realDims, projections } = await discoverAxes(vectors, titles.map((t) => t.slice(0, 64)), { llm });
  if (!opts.quiet) console.error(`  ${axes.length} local axes surfaced (${realDims} dims above the noise floor)`);
  const scores = projectionScores(projections, axes);
  const rawScores = rawProjectionScores(projections, axes);

  if (!opts.quiet) console.error(`[2/3] re-projecting + re-clustering the subset…`);
  const { xy, xyz, xyzAgree, cluster, k, di, levels, counts, hub, nbr } = await projectAndCluster(vectors);

  if (!opts.quiet) console.error(`[3/3] naming ${counts.length} grain levels (${counts.join("·")}; default ${k})…`);
  const axLite = axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high }));
  const cache = typeof opts.cacheDir === "string" ? fileStore(join(opts.cacheDir, "region-cache.jsonl")) : undefined;
  const { levelLabels, levelBlurbs, clusters } = await (async () => {
    const r = await nameLevels(levels, counts, titles, cores, scores, axLite, { llm, sig: opts.sig, concurrency: conc, cache });
    return { levelLabels: r.labels, levelBlurbs: r.blurbs, clusters: regionCentroids(r.regionsByLevel[di], cluster, k, xy) };
  })();

  // intra-corpus citation edges survive descent when both ends are in the subset (indices remapped)
  const remap = new Map(idx.map((pi, ci) => [pi, ci]));
  const cite = P.cite ? idx.map((pi) => P.cite![pi].map((j) => remap.get(j)).filter((j): j is number => j != null)) : undefined;

  const parentTitle = P.provenance?.title ?? "parent map";
  const D: MapContract = {
    ids: selIds.slice(), titles, cores,
    notes: idx.map(() => ({})),   // parent notes are placements on the PARENT's axes — honest is empty, not misfiled
    axes: axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high, variance: a.var, weak: a.var < 0.02 })),
    scores, rawScores, xy, xyz, xyzAgree, cluster, k, di, levels, counts, levelLabels, levelBlurbs, clusters, hub, nbr,
    cite, citec: sub(P.citec ?? undefined),
    urls: sub(P.urls), sources: sub(P.sources), siteNames: sub(P.siteNames), authors: sub(P.authors),
    tags: sub(P.tags), dates: sub(P.dates), read: sub(P.read), folders: sub(P.folders),
    vectors: { data: Float32Array.from(vectors.flat()), dim: vdim },
  };
  // provenance — the child introduces itself AS a descent: parent map, selection size, date (about pane)
  D.provenance = {
    title: opts.name || `${parentTitle} ▸ descent (${idx.length})`,
    source: `descend of "${parentTitle}" — ${idx.length} of ${P.ids.length} cards${opts.parentFile ? ` · ${opts.parentFile}` : ""}`,
    generated: Date.now(), count: idx.length,
  };
  D.derivedBy = { ...P.derivedBy, generated: Date.now() };   // same basis/embedder as the parent — descend adds no new model
  D.metaFields = buildMetaFields(D);
  const nNodes = D.ids.length;
  for (const key of Object.keys(D.scores)) if (D.scores[key].length !== nNodes) throw new Error(`descend invariant violated: scores.${key}.length=${D.scores[key].length} != ids.length=${nNodes}`);
  return D;
}

if (import.meta.main) {
  const { docs, embeddings } = loadFixture();
  await run(docs, embeddings);
}
