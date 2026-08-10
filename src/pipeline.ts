import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deckToJSONL } from "./card.ts";
import { poolEmbed, buildMetaFields, knnIndex, type Embedder } from "./map.ts";
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
import { buildMap, regionCentroids, descendMap as engineDescend, type EngineProgress } from "./engine.ts";

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
    else if (p.stage === "axes-noise") process.stderr.write(`  noise floor: shuffle replicate ${p.rep}/${p.of}\r`);
    else if (p.stage === "axes-naming") say(`  naming ${p.axes} axes (one contrastive call)…`);
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

// DESCEND, node face (eid-nuwd → eid-kep3): the core is host-free in src/engine.ts (the page's
// selection pane runs the SAME function). This binding resolves provider() from env, a file-backed
// region-label cache, and narrates the engine's honest progress stream on stderr.
export async function descendMap(P: MapContract, selIds: string[], opts: { llm?: any; sig?: any; name?: string; parentFile?: string; concurrency?: number; cacheDir?: string; quiet?: boolean } = {}): Promise<MapContract> {
  const say = (s: string) => { if (!opts.quiet) console.error(s); };
  const onProgress = (p: EngineProgress) => {
    if (p.stage === "axes") say(`[1/3] descending: re-discovering axes over ${p.docs} of ${P.ids.length} cards…`);
    else if (p.stage === "axes-done") say(`  ${p.axes} local axes surfaced (${p.realDims} dims above the noise floor)`);
    else if (p.stage === "layout") say(`[2/3] re-projecting + re-clustering the subset…`);
    else if (p.stage === "regions") { if (p.done === 1) say(`[3/3] naming regions…`); if (!opts.quiet && p.total && (p.done % 25 === 0 || p.done === p.total)) process.stderr.write(`  regions ${p.done}/${p.total}\r`); }
  };
  return engineDescend(P, selIds, {
    llm: opts.llm ?? provider(), sig: opts.sig,
    name: opts.name, parentFile: opts.parentFile,
    concurrency: opts.concurrency ?? Number(process.env.EIDOSCOPE_CONCURRENCY || 24),
    regionCache: typeof opts.cacheDir === "string" ? fileStore(join(opts.cacheDir, "region-cache.jsonl")) : undefined,
    onProgress,
  });
}

if (import.meta.main) {
  const { docs, embeddings } = loadFixture();
  await run(docs, embeddings);
}
