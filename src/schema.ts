// THE VIEWER DATA CONTRACT — the single seam between the pipeline (which EMITS a map) and the viewer
// (which CONSUMES it). Formalizing this is what lets the two evolve independently: the pipeline can
// change how it discovers/cards/clusters, and the viewer can be rebuilt on any stack (today: Svelte +
// deck.gl), as long as both sides honor THIS shape. Versioned, so a viewer can refuse or adapt to an
// older/newer emit instead of silently misreading it.
//
// Wire format: this logical shape is serialized as the ONE .eido container (docs/EIDO-FORMAT.md,
// src/eido-container.ts — v2.2): numeric data as typed-array buffers, textual per-doc/per-region/view
// content as ragged utf8 JSON rows, a small O(axes+levels) meta JSON, the whole payload gzipped.
// The FIELDS below are the contract; the encoding is an implementation detail beneath them.
// (History in one line: earlier internal layouts existed during development; every .eido was
// regenerated when v2.2 landed and nothing else is read or written.)
export const CONTRACT_VERSION = 2;   // a human capability signal — readers gate on has* flags and buffer presence, never on this number

// ── THE GRAIN LADDER CONTRACT (eid-iw04) ─────────────────────────────────────────────────────────────
// Measured on the real corpora (markdown-export n=1446, pathfinder n=13830): the card-embedding space
// clumps at EVERY scale and selects no grain of its own — the gap statistic keeps supporting splits down
// to near-singletons (469 of 1446), seed-perturbation stability (Jaccard ≥ 0.75, Hennig 2007) stops at 3,
// and simplified silhouette is flat (~0.08–0.10) across all levels. So a data-derived ladder does not
// exist; the ladder is an explicit, GENERATED UI pragmatic — these three constants are its whole
// definition, shared structurally by pipeline and viewer (this file is the one shared seam):
export const GRAIN_MIN_REGION = 25; // a named region should summarize a GROUP, not list a handful; splitting
                                    // stops at this floor, so the ladder's top (kmax) EMERGES per corpus
export const GRAIN_RATIO = 1.5;     // slider granularity: one notch ≈ ×1.5 regions, from k=2 (the smallest
                                    // nontrivial partition) up to kmax — constant perceptual step, no list
export const GRAIN_PALETTE_N = 24;  // categorical colours the theme-derived palette holds apart (viewer/src/
                                    // palette.ts); the DEFAULT grain is the finest level that still fits

// One discovered axis: a deterministic PCA direction, LLM-labeled. `weak` = below the variance floor.
// Row-major flat card-embedding matrix: row i = data.subarray(i * dim, (i + 1) * dim).
export type CardVectors = { data: Float32Array; dim: number };

export type AxisDef = { key: string; name: string; low: string; high: string; variance?: number; weak?: boolean };

// One named region at one grain level. Positions/counts are derivable from `cluster`+`levels`, so a
// region is just identity + label; the viewer computes centroids from live node positions.
export type RegionDef = { c: number; n: number; label: string; blurb?: string; cx?: number; cy?: number };

// A frontier "ghost" — a cited-but-not-in-corpus paper, placed near the work that cites it.
export type GhostDef = { title: string; arxiv: string; url: string; n: number; core: string; xy: [number, number]; sim: number };

// v2 — a TYPED declaration of one encodable dimension (the substrate of the channel grammar). The pipeline
// declares each corpus field + its TYPE; the viewer offers only type-appropriate visual channels for it and
// resolves `source` to values with its own accessors (no derivation logic duplicated into the file).
//   source: "col:<field>"  read the named per-node column (authors/siteNames/tags/dates/read/hub/citec)
//           "axis:<key>"    a discovered axis's per-node score (a scalar dimension)
//           "derived:<k>"   the viewer derives it (e.g. folder from urls, length from cores)
export type MetaField = {
  key: string;
  label: string;
  type: "categorical" | "scalar" | "temporal" | "boolean";
  multi?: boolean;              // value is a list (e.g. tags)
  source: string;
};

// ── SAVED VIEWS (eid-thbs) ───────────────────────────────────────────────────────────────────────────
// A named view IS the file's own state object — the same shape the viewer's URL (de)serializes, carried
// in the .eido so a configured way of looking travels WITH the corpus. Deliberately id-based and complete:
// the file has no length problem, so selections and derived-axis examples are FULL card-id lists here —
// no cap, no reference to URL capacity anywhere. The URL string form is just one (lossy, capped) encoding
// of this same object; this is the uncapped one.
export type ViewChannelKey = "color" | "size" | "x" | "y" | "z" | "scrub" | "sort";
export type ViewState = {
  layout?: "mde" | "axes" | "orbit" | "axes3d";
  channels?: Partial<Record<ViewChannelKey, string>>;   // channel → dimension key (or sentinel)
  grain?: number;
  dimProps?: Record<string, { norm: "honest" | "rank"; invert: boolean }>;
  window?: { lo?: number; hi?: number };                // the scrub window, on channels.scrub
  region?: number;                                       // isolated region (cluster id at `grain`)
  facet?: string;                                        // isolated categorical value (on channels.color)
  find?: string;                                         // the substring filter
  card?: string;                                         // the open card's id
  queries?: string[];                                    // semantic-query dimension texts (re-embedded on open)
  derived?: { label: string; key: string; ids: string[] }[];  // derived dims with FULL example ids
  selection?: string[];                                  // the held set as FULL card ids
  camera?: { target: number[]; zoom: number; rot?: number | null; rotX?: number | null };
  // overlays, labels, and the deck's own state (M-B) — view state like everything else here
  cite?: boolean; ghosts?: boolean; labels?: boolean;
  deckOpen?: boolean; deckQ?: string; deckUnread?: boolean;
};
export type SavedView = { name: string; created: number; state: ViewState };

// The full map. Arrays are node-indexed and parallel (index i = the i-th document/card) unless noted.
export type MapContract = {
  version?: number;                        // CONTRACT_VERSION at emit time (absent = pre-versioned, treated as v1)

  // provenance — so a file that gets passed around can introduce itself (what corpus, from where, when, how big)
  provenance?: { title?: string; source?: string; generated?: number; count?: number };

  // v2 — HOW the map was made, for transparency AND reuse. `geometryBasis` is the honesty field: whether the
  // layout was built on the cards (the concept bottleneck) or raw full text (--embed raw). `embedder` is the
  // meta-embedding info a viewer needs to embed a query into the SAME space as `vectors` (custom semantic axes).
  derivedBy?: {
    cardModel?: string;
    embedder?: { id: string; dim: number; pooling?: string; normalized?: boolean };
    geometryBasis?: "card" | "raw";
    neighbors?: string;  // which kNN regime built nbr + the UMAP graph: "exact-gpu" (recall 1.0) | "exact-cpu" | "hnswlib-node" | "hnswlib-wasm"
    pipelineVersion?: string;
    generated?: number;
  };

  // v2 OPTIONAL — per-node card embedding (the layout substrate). Carried so a passed-around file is
  // re-interrogable offline (custom semantic axes, new-point placement) with no model. Stored f16 on the
  // wire (measured lossless for cosine ranking, half the bytes). Absent in a "lite" emit.
  // In memory it stays ONE flat Float32Array (row i = data.subarray(i*dim, (i+1)*dim)) — materializing
  // n little JS arrays was measured as the single biggest decode-memory cost (see eid-cl83 notes).
  vectors?: CardVectors;

  // v2 OPTIONAL — the typed dimension manifest (see MetaField). Lets the viewer's channel grammar offer
  // each corpus's own fields as encodable channels, type-checked, instead of a hard-coded folder/author set.
  metaFields?: MetaField[];

  // identity + reader-facing content (per node)
  ids: string[];
  titles: string[];
  cores: string[];                         // the card restatement (the de-noised text)
  notes: Record<string, string>[];         // per node: axisKey -> placement note

  // the discovered structure
  axes: AxisDef[];
  scores: Record<string, number[]>;        // axisKey -> per-node rank-normalized 0..100 position
  rawScores?: Record<string, number[]>;    // axisKey -> per-node RAW PCA projection (optional; lets the viewer
                                           // offer an "honest" min-max view of an axis, not just the even-spread rank)

  // geometry (Float32 on the wire): 2D map, 3D orbit
  xy: number[][];
  xyz: number[][];
  // `xy` and `xyz` are two INDEPENDENT UMAP fits of the same card vectors — the 3D cloud is NOT the 2D
  // map with depth. xyzAgree quantifies that honestly: mean count of a card's 8 nearest neighbors in the
  // 2D layout that are still among its 8 nearest in the 3D layout (0..8), measured per corpus at emit
  // time. Surfaced in the viewer's about pane (eid-ovo7). Optional: absent in pre-existing files.
  xyzAgree?: number;

  // the nested grain ladder (clumps-all-the-way-down). `cluster` is the default level = levels[di].
  // The ladder is GENERATED, not hand-tuned — see the GRAIN_* constants below and src/cluster.ts.
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
  // source folder per node (parent directory of the ingested file). Carried as a real column because the
  // viewer can only DERIVE a folder from file:// urls — docs with real web urls (e.g. tldr's upstream
  // links) would otherwise lose their on-disk organization, which is often the best categorical facet.
  folders?: (string | undefined)[];

  // frontier telescope
  ghosts?: GhostDef[];

  // named, saved views (eid-thbs) — the file carries its own ways of being looked at. Optional and
  // additive: old files lack it and load unchanged; old viewers ignore it.
  views?: SavedView[];
};

// Narrow structural check that an object satisfies the contract's required core (not a deep validator —
// a fast guard the loader runs so a malformed/old emit fails loudly at the seam, not deep in rendering).
export function isMapContract(d: any): d is MapContract {
  return !!d && Array.isArray(d.ids) && Array.isArray(d.xy) && Array.isArray(d.axes)
    && d.scores && typeof d.k === "number" && Array.isArray(d.cluster)
    && d.ids.length === d.xy.length && d.ids.length === d.cluster.length;
}
