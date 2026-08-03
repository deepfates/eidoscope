// THE VIEWER DATA CONTRACT — the single seam between the pipeline (which EMITS a map) and the viewer
// (which CONSUMES it). Formalizing this is what lets the two evolve independently: the pipeline can
// change how it discovers/cards/clusters, and the viewer can be rebuilt on any stack (today: Svelte +
// deck.gl), as long as both sides honor THIS shape. Versioned, so a viewer can refuse or adapt to an
// older/newer emit instead of silently misreading it.
//
// Wire format (see ticket eid-6wek): this logical shape is serialized as binary — coordinates, scores,
// and any embeddings as Float32 typed arrays; per-node metadata columnar (Apache Arrow); the whole
// payload gzipped. JSON is the fallback/debug form. The FIELDS below are the contract; the encoding is
// an implementation detail beneath them.

export const CONTRACT_VERSION = 1;

// One discovered axis: a deterministic PCA direction, LLM-labeled. `weak` = below the variance floor.
export type AxisDef = { key: string; name: string; low: string; high: string; variance?: number; weak?: boolean };

// One named region at one grain level. Positions/counts are derivable from `cluster`+`levels`, so a
// region is just identity + label; the viewer computes centroids from live node positions.
export type RegionDef = { c: number; n: number; label: string; blurb?: string; cx?: number; cy?: number };

// A frontier "ghost" — a cited-but-not-in-corpus paper, placed near the work that cites it.
export type GhostDef = { title: string; arxiv: string; url: string; n: number; core: string; xy: [number, number]; sim: number };

// The full map. Arrays are node-indexed and parallel (index i = the i-th document/card) unless noted.
export type MapContract = {
  version?: number;                        // CONTRACT_VERSION at emit time (absent = pre-versioned, treated as v1)

  // provenance — so a file that gets passed around can introduce itself (what corpus, from where, when, how big)
  provenance?: { title?: string; source?: string; generated?: number; count?: number };

  // identity + reader-facing content (per node)
  ids: string[];
  titles: string[];
  cores: string[];                         // the card restatement (the de-noised text)
  notes: Record<string, string>[];         // per node: axisKey -> placement note

  // the discovered structure
  axes: AxisDef[];
  scores: Record<string, number[]>;        // axisKey -> per-node rank-normalized 0..100 position

  // geometry (Float32 on the wire): 2D map, 3D orbit
  xy: number[][];
  xyz: number[][];

  // the nested grain ladder (clumps-all-the-way-down). `cluster` is the default level = levels[di].
  cluster: number[];                       // per node: region index at the default grain
  k: number;                               // region count at the default grain
  di?: number;                             // default level index into levels/counts
  levels?: number[][];                     // per level: per-node region assignment
  counts?: number[];                       // per level: region count
  levelLabels?: string[][];                // per level: label per region
  levelBlurbs?: string[][];                // per level: blurb per region
  clusters: RegionDef[];                   // convenience: the default-level regions

  // relational structure
  hub: number[];                           // per node: kNN in-degree (influence)
  nbr: number[][];                         // per node: nearest-neighbor node indices
  cite?: number[][];                       // per node: intra-corpus citation edges (node indices)
  citec?: number[];                        // per node: external citation impact

  // optional per-node metadata (columnar on the wire); any may be absent/sparse
  urls?: (string | undefined)[];           // the canonical link (e.g. the Readwise reader link)
  sources?: (string | undefined)[];        // the ORIGINAL source url the doc was saved from (arxiv/blog/…) — lets a shared map link out even for viewers who can't open the reader link
  siteNames?: (string | undefined)[];      // a human label for the source link ("arXiv.org", the blog name)
  authors?: (string | undefined)[];
  tags?: (string[] | undefined)[];
  dates?: (number | undefined)[];
  read?: (boolean | undefined)[];

  // frontier telescope
  ghosts?: GhostDef[];
};

// Narrow structural check that an object satisfies the contract's required core (not a deep validator —
// a fast guard the loader runs so a malformed/old emit fails loudly at the seam, not deep in rendering).
export function isMapContract(d: any): d is MapContract {
  return !!d && Array.isArray(d.ids) && Array.isArray(d.xy) && Array.isArray(d.axes)
    && d.scores && typeof d.k === "number" && Array.isArray(d.cluster)
    && d.ids.length === d.xy.length && d.ids.length === d.cluster.length;
}
