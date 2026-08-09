// THE ENGINE, host-free — the full instrument from docs+full-text-embeddings to a finished MapContract:
// discover axes → card → embed cards → project + cluster → name regions → assemble. This is the ONE
// implementation both faces run: the CLI (src/pipeline.ts wraps it with the on-disk caches, hnswlib and
// file emission) and the in-page ingest (viewer/src/ingest.ts wraps it with the transformers.js embedder
// and an OpenRouter client built from the user-held key). Neither host forks a stage; they inject seams:
// the llm client, the text embedder, the caches, approximate kNN, and a progress callback.
import { discoverAxes, type Axis } from "./axes.ts";
import { cardCorpus, type Card } from "./card.ts";
import { nameLevels, type Region } from "./regions.ts";
import { Store } from "./llm.ts";
import {
  cardText, projectionScores, rawProjectionScores, buildMetaFields, projectAndCluster,
  type ApproxKnn, type LayoutKnnApprox,
} from "./geometry.ts";
import { INPAGE_ENVELOPE_DOCS } from "./defaults.ts";
import type { Doc } from "./corpus-core.ts";
import type { MapContract } from "./schema.ts";

export { INPAGE_ENVELOPE_DOCS };

// Honest per-stage progress — what a UI (or the CLI's stderr) narrates while the engine works.
export type EngineProgress =
  | { stage: "axes"; docs: number }
  | { stage: "axes-done"; axes: number; realDims: number }
  | { stage: "cards"; done: number; total: number; failed: number }
  | { stage: "embed-cards"; cards: number }
  | { stage: "layout"; cards: number }
  | { stage: "regions"; done: number; total: number };

// Default-grain regions with an on-map centroid (median position) for the label + legend — the ONE
// implementation, shared by buildMap / relabelMap / descendMap (it was hand-copied in two of them).
export function regionCentroids(regions: { c: number; n: number; label: string }[], cluster: number[], k: number, xy: number[][]) {
  const dGroups: number[][] = Array.from({ length: k }, () => []);
  cluster.forEach((c, i) => dGroups[c].push(i));
  return regions.map((r, c) => {
    const g = dGroups[c] || []; const xs = g.map((i) => xy[i][0]).sort((a, b) => a - b), ys = g.map((i) => xy[i][1]).sort((a, b) => a - b);
    return { c: r.c, n: r.n, label: r.label, cx: xs[xs.length >> 1] || 0, cy: ys[ys.length >> 1] || 0 };
  });
}

export type BuildOpts = {
  llm: any;                                            // the ax client (CLI: provider(); page: user-held key)
  // embed a list of card texts → vectors, chunk-pooled (node: poolEmbed w/ disk cache; page: transformers.js
  // through geometry.poolEmbedWith). Only consulted for the default card basis; --embed raw skips it.
  embedCardTexts: (texts: string[]) => Promise<number[][]>;
  cardSig?: any; regionSig?: any;                      // test seams (mock signatures)
  cardCache?: Store; regionCache?: Store;              // content-addressed caches (file-backed or session-memory)
  concurrency?: number;
  embed?: "card" | "raw";
  approxKnn?: ApproxKnn; layoutApprox?: LayoutKnnApprox; // node injects hnswlib; the page injects nothing
  name?: string; source?: string;
  cardModel?: string; embedderId?: string;             // provenance (derivedBy)
  onProgress?: (p: EngineProgress) => void;
  // a host that already ran discovery (e.g. the page's keyless axes-preview) hands it in — the same
  // deterministic result, not re-spent
  discovered?: { axes: Axis[]; realDims: number; projections: number[][] };
};

export type BuildResult = { D: MapContract; deck: Card[]; axes: Axis[]; embs: number[][]; deckProjections: number[][] };

// The full engine, end to end. Throws (never half-emits) on: every card failing, zero docs, misaligned
// node-indexed arrays. The caller owns emission (files on node, mountMap in the page).
export async function buildMap(docs: Doc[], embeddings: number[][], opts: BuildOpts): Promise<BuildResult> {
  const on = opts.onProgress ?? (() => {});
  const conc = opts.concurrency ?? 12;

  on({ stage: "axes", docs: docs.length });
  const { axes, realDims, projections } = opts.discovered ?? await discoverAxes(embeddings, docs.map((d) => d.title.slice(0, 64)), { llm: opts.llm });
  on({ stage: "axes-done", axes: axes.length, realDims });

  const deck = await cardCorpus(docs, axes, {
    llm: opts.llm, sig: opts.cardSig, concurrency: conc, cache: opts.cardCache,
    onProgress: (done, total, failed) => on({ stage: "cards", done, total, failed }),
  });
  if (!deck.length) throw new Error("no cards were produced — refusing to emit an empty map"); // belt to cardCorpus's own guard

  // The map geometry comes from EITHER the cards (concept-bottleneck: the default) OR the raw full-text
  // embeddings already computed for axis discovery (--embed raw). Same axes, same cards for the reader/
  // region-naming either way — only what the layout+clusters are built on changes, a clean A/B on
  // whether the card transformation helps this corpus.
  const useRaw = opts.embed === "raw";
  // Geometry must be built over the SAME set as identity (the deck). cardCorpus drops docs whose card
  // failed, so `deck` can be shorter than `docs`/`embeddings` — align the raw embeddings to the deck by
  // id (else xy/cluster get the dropped doc's row and every node-indexed array is off by one).
  const embOfId = useRaw ? new Map(docs.map((d, i) => [d.id, embeddings[i]])) : null;
  if (!useRaw) on({ stage: "embed-cards", cards: deck.length });
  const embs = useRaw ? deck.map((c) => embOfId!.get(c.id)!) : await opts.embedCardTexts(deck.map((c) => cardText(c, axes)));
  // The axis projections were computed over ALL docs (axis discovery runs before carding) — align them
  // to the deck by id too, or a single failed card shifts every scores row after it (emit invariant
  // catches the length; without it every downstream array would be silently off by one).
  const projOfId = new Map(docs.map((d, i) => [d.id, projections[i]]));
  const deckProjections = deck.map((c) => projOfId.get(c.id)!);
  on({ stage: "layout", cards: deck.length });
  const geo = await projectAndCluster(embs, { approxKnn: opts.approxKnn, layoutApprox: opts.layoutApprox });

  // Name EVERY grain level contrastively — the deterministic layer computes what makes each region
  // distinct (over-used terms + extreme axes), the LLM only phrases it. Deduped across levels + cached.
  const scores = projectionScores(deckProjections, axes);
  const rawScores = rawProjectionScores(deckProjections, axes);   // true-magnitude coords → viewer "honest" axis toggle
  const axLite = axes.map((a) => ({ key: a.key, name: a.name, low: a.pole_low, high: a.pole_high }));
  const { labels: levelLabels, blurbs: levelBlurbs, regionsByLevel } = await nameLevels(
    geo.levels, geo.counts, deck.map((c) => c.title), deck.map((c) => c.core), scores, axLite,
    { llm: opts.llm, sig: opts.regionSig, concurrency: conc, cache: opts.regionCache, onProgress: (done, total) => on({ stage: "regions", done, total }) });

  const D = assembleContract({ deck, axes, scores, rawScores, geo, levelLabels, levelBlurbs, regionsByLevel, embs, useRaw, name: opts.name, source: opts.source, cardModel: opts.cardModel, embedderId: opts.embedderId });
  return { D, deck, axes, embs, deckProjections };
}

// Assemble the finished MapContract from the stages' outputs — invariants checked, provenance recorded.
// One implementation for both hosts, so a page-built map and a CLI-built map cannot drift in shape.
export function assembleContract(a: {
  deck: Card[]; axes: Axis[]; scores: Record<string, number[]>; rawScores: Record<string, number[]>;
  geo: { xy: number[][]; xyz: number[][]; xyzAgree: number; cluster: number[]; k: number; di: number; levels: number[][]; counts: number[]; hub: number[]; nbr: number[][] };
  levelLabels: string[][]; levelBlurbs: string[][]; regionsByLevel: Region[][];
  embs: number[][]; useRaw: boolean; name?: string; source?: string; cardModel?: string; embedderId?: string;
}): MapContract {
  const { deck, axes, geo } = a;
  const clusters = regionCentroids(a.regionsByLevel[geo.di], geo.cluster, geo.k, geo.xy);
  const D: MapContract = {
    ids: deck.map((c) => c.id), titles: deck.map((c) => c.title), cores: deck.map((c) => c.core),
    notes: deck.map((c) => Object.fromEntries(axes.map((ax) => [ax.key, c.axes[ax.key]?.note || ""]))),
    axes: axes.map((ax) => ({ key: ax.key, name: ax.name, low: ax.pole_low, high: ax.pole_high, variance: ax.var })),
    scores: a.scores, rawScores: a.rawScores,
    xy: geo.xy, xyz: geo.xyz, xyzAgree: geo.xyzAgree, cluster: geo.cluster, k: geo.k, di: geo.di, hub: geo.hub, nbr: geo.nbr,
    clusters, levels: geo.levels, counts: geo.counts, levelLabels: a.levelLabels, levelBlurbs: a.levelBlurbs,
    urls: deck.map((c) => c.url || (c.path ? "file://" + c.path : undefined)),
    // parent-directory facet, carried explicitly (docs with web urls would otherwise lose it — schema.ts)
    folders: deck.map((c) => { const p = (c.path || "").split("/").filter(Boolean); return p.length >= 2 ? p[p.length - 2].replace(/_/g, " ") : undefined; }),
    sources: deck.map((c) => c.source), siteNames: deck.map((c) => c.siteName),
    authors: deck.map((c) => c.author), tags: deck.map((c) => c.tags), dates: deck.map((c) => c.date),
    read: deck.map((c) => (c.readProgress != null ? c.readProgress > 0.05 : undefined)),
  };
  // Positions ARE the deterministic PCA projection — the LLM never scores. Honesty is the variance each
  // axis explains: a "minor" axis (<2%) is a real but thin direction — surfaced and flagged.
  D.axes.forEach((ax, i) => { ax.weak = axes[i].var < 0.02; });
  // every node-indexed array must have exactly one entry per card — fail loud, never emit a broken map
  const nNodes = D.ids.length;
  for (const [name, arr] of ([["titles", D.titles], ["cores", D.cores], ["notes", D.notes], ["xy", D.xy], ["xyz", D.xyz], ["cluster", D.cluster], ["hub", D.hub], ["nbr", D.nbr]] as [string, unknown[]][]))
    if (arr.length !== nNodes) throw new Error(`emit invariant violated: ${name}.length=${arr.length} != ids.length=${nNodes} (a node-indexed array is misaligned)`);
  for (const key of Object.keys(D.scores)) if (D.scores[key].length !== nNodes) throw new Error(`emit invariant violated: scores.${key}.length=${D.scores[key].length} != ids.length=${nNodes}`);
  // provenance — so a passed-around file introduces itself (what corpus, from where, when, how big)
  D.provenance = { title: a.name || "Corpus", source: a.source, generated: Date.now(), count: nNodes };
  // v2: carry the card vectors (the re-interrogation substrate) + how the map was made. `embs` is exactly
  // what the layout was built on, aligned to the deck; geometryBasis records which — so the file can't
  // misrepresent whether it went through the bottleneck.
  if (a.embs?.length === nNodes && a.embs[0]?.length) {
    const dim = a.embs[0].length, data = new Float32Array(nNodes * dim);
    for (let i = 0; i < nNodes; i++) for (let j = 0; j < dim; j++) data[i * dim + j] = a.embs[i][j];
    D.vectors = { data, dim };   // flat row-major (schema CardVectors) — never n little JS arrays
  }
  D.derivedBy = {
    cardModel: a.cardModel,
    embedder: { id: a.embedderId ?? "", dim: a.embs?.[0]?.length ?? 0, pooling: "mean", normalized: true },
    geometryBasis: a.useRaw ? "raw" : "card",
    generated: Date.now(),
  };
  D.metaFields = buildMetaFields(D);   // typed dimension manifest for the channel grammar
  return D;
}
