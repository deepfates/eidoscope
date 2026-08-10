# The .eido file format

A `.eido` file is one corpus turned into a portable, self-describing map: the documents' *cards*
(short readable restatements), the axes and layout discovered from them, and the ways of looking
at them that the owner saved. It is pure data — no HTML, no application code. Any tool can read
or write one using only this document; you do not need eidoscope's code.

This spec has two audiences:

1. **A developer** implementing a reader or writer in another tool. Everything down to the byte
   is in "The wire format" below.
2. **A user** who wants to know what their file contains, what can be rebuilt if lost, and what
   is irreplaceable. That is "The three strata", next.

The code of record is `src/eido-container.ts` (the codec), `src/schema.ts` (the logical shape,
`MapContract`), and `src/mapbin.ts` (the gzip wrapper). `test/format-doc.test.ts` decodes a real
fixture and a fully-populated synthetic file and asserts that the field tables in this document
exactly match what the codec emits — so this spec cannot silently drift from the code.

---

## Part 1 — What the file contains: the three strata

Every field in a `.eido` belongs to one of three strata, distinguished by one question: *if this
were deleted, could it be recomputed?*

### Stratum 1: Source truth — the cards

The cards are the document itself. They were produced once, by reading the original corpus:
each source document was restated by a language model as a **card** — a title, a *core* (a short
de-noised restatement of the document), and per-axis *placement notes* (a sentence explaining
where the document sits on each discovered axis). Alongside them ride the document's identity
and metadata: its id, links, author, tags, dates, read state, source folder.

**Not recomputable from the file.** The original corpus and the model calls that made the cards
are not in the file. Lose this stratum and the document is gone.

Fields: `ids`, `titles`, `cores`, the notes (see the notes blocks below), `urls`, `sources`,
`siteNames`, `authors`, `tags`, `dates`, `read`, `folders`, `citec`, `ghosts`, and the file's
self-introduction `provenance` (corpus title, source path/URL, generation time, document count).

### Stratum 2: Caches — recomputable, with one declared shift

Everything geometric and structural: the card embedding vectors, the discovered axes and each
document's scores on them, the 2D and 3D layouts, the nearest-neighbor graph, the cluster
ladder and its labels. All of it is *derived* — carried because the computation is expensive
and worth sharing, but re-derivable from the cards.

**The declared basis shift.** One honesty caveat, stated rather than hidden: the axes in the
file were *discovered* from embeddings of the documents' **full text**, and each document's
axis score is its projection in that full-text space. The file does not carry full-text
embeddings (measured at +37–57% file size; ruled out as the default). So a recompute done from
the file alone works in **card basis** — embeddings of the cards, not of the originals — and
will reproduce the neighbor map faithfully but can only approximate the axes. A true
*truth-basis* recompute requires re-fetching the corpus; `provenance.source` records where it
came from so a tool can do that when the source is reachable. The `derivedBy.geometryBasis`
field declares which basis the file's own geometry was built on.

Fields: `vectors` (buffer), `color` (buffer), `axes`, `scores`, `rawScores`, `xy`, `xyz`, `xyzAgree`, `cluster`,
`k`, `di`, `levels`, `counts`, `levelLabels`, `levelBlurbs`, `clusters`, `hub`, `nbr`, `cite`,
and the recipe record `derivedBy` (card model, embedder id/dimension, geometry basis, pipeline
version, generation time).

### Stratum 3: Work — the user's own

Named **views**: saved configurations of how to look at the map — which layout, which
dimensions on which visual channels, filters, an isolated region, a held selection (as full
card-id lists), user-derived axes with their example cards, camera position. This is the
owner's work product, saved in the file so it travels with the corpus and restores in any
instance of the app.

Neither source truth nor cache: it cannot be recomputed, but losing it loses only *your
arrangement*, not the document.

Fields: `views` (a list of `{name, created, state}`; the `state` object is described under
"View state" below).

---

## Part 2 — The wire format

### Layer 0: outer gzip

A `.eido` file on disk is a standard **gzip** stream (RFC 1952 — the first two bytes are
`1f 8b`). Gunzip it to get the container.

### Layer 1: the container

The uncompressed container is laid out as:

```
"EIDOBIN1"            8 bytes ascii — the magic
metaLen               u32, little-endian
metaJSON              metaLen bytes of UTF-8 JSON, then zero-padded to a 4-byte boundary
buffers region        the numeric buffers, concatenated, each 4-byte aligned
```

A reader: check the magic, read `metaLen` at byte offset 8, parse the JSON at bytes
`12 .. 12+metaLen`. The buffers region begins at `12 + metaLen + pad` where
`pad = (4 - metaLen % 4) % 4`. All buffer offsets in the manifest are relative to the start of
the buffers region.

### The meta JSON

The meta object carries the file's structural description plus a manifest of the binary buffers.
Nothing in it grows with the document count or with the user's saved work: per-node
content rides in the `prow_*` row buffers, per-region content in `rrow_*`, saved views in `vrow_*`
(all described below), so a reader can parse the meta in one bounded step and expand the rest
incrementally. JSON serialization drops keys whose value is `undefined`, so optional keys are
simply absent. Every key the encoder can emit:

Stratum letters: **S** = source truth, **C** = cache, **W** = work, **F** = file plumbing.

| key | type | required | stratum | meaning |
|---|---|---|---|---|
| `version` | number | yes | F | contract version at emit time (currently 2). A capability signal, not a decode gate: readers gate on the `has*` flags and buffer presence, never on this number. |
| `n` | number | yes | F | document count; every per-node array/buffer has this many rows |
| `provenance` | object | no | S | `{title?, source?, generated?, count?}` — what corpus, from where, when, how big |
| `derivedBy` | object | no | C | `{cardModel?, embedder?: {id, dim, pooling?, normalized?}, geometryBasis?: "card"\|"raw", pipelineVersion?, generated?}` — how the map was made; `embedder` lets a tool embed a query into the same space as `vectors` |
| `metaFields` | array | no | S | typed dimension manifest: `{key, label, type: "categorical"\|"scalar"\|"temporal"\|"boolean", multi?, source}` where `source` is `col:<field>` (a hand-declared top-level column), `mcol:<key>` (the generic column store — a disjoint namespace, so a source column named like a native field never shadows it), `axis:<key>`, or `derived:<k>` |
| `axes` | array | yes | C | `{key, name, low, high, variance?, weak?}` per discovered axis; order defines the row order of the `scores`/`rawScores` buffers |
| `k` | number | yes | C | region count at the default cluster grain |
| `di` | number | no | C | default level index into `levels`/`counts` |
| `xyzAgree` | number | no | C | 2D↔3D neighborhood agreement (mean shared 8-nearest-neighbors, 0..8) |
| `counts` | number[] | no | C | per cluster level: region count |
| `cols` | object | yes | F | which optional per-node columns the `prow_*` rows carry: `{urls, sources, siteNames, authors, tags, dates, read, folders, citec}` booleans — a column marked false decodes as absent, never as an all-null column |
| `hasLevelLabels` | boolean | yes | F | whether the level-label segment of `rrow_*` is present (distinguishes `[]` from absent) |
| `levelCounts` | number[] | yes | F | per cluster level: how many label rows that level contributes to `rrow_*` |
| `hasBlurbs` | boolean | yes | F | whether the level-blurb segment of `rrow_*` is present — independent of `hasLevelLabels` |
| `blurbCounts` | number[] | yes | F | per cluster level: how many blurb rows that level contributes to `rrow_*` |
| `clustersN` | number | yes | F | how many default-level RegionDef rows follow the blurb segment in `rrow_*` |
| `hasGhosts` | boolean | yes | F | whether the ghost segment of `rrow_*` is present (distinguishes `[]` from absent) |
| `ghostsN` | number | yes | F | how many ghost rows end `rrow_*` |
| `hasViews` | boolean | yes | F | whether the `vrow_*` buffers carry saved views (distinguishes `[]` from absent) |
| `viewsN` | number | yes | F | number of saved-view rows in `vrow_*` |
| `mcols` | array | no | S | generic column-store descriptors, in order: `{key, label, type: "categorical"\|"scalar"\|"temporal"\|"boolean", multi?}` — values ride the `mcol*` buffers (layout below); absent = the map carries no generic columns |
| `hasLevels` | boolean | yes | F | whether the `levels_v`/`levels_o` buffers are present |
| `hasCite` | boolean | yes | F | whether the `cite_v`/`cite_o` buffers are present |
| `hasVectors` | boolean | yes | F | whether the `vectors` buffer is present (false in a "lite" emit) |
| `hasColor` | boolean | yes | F | whether the `color` buffer (per-card colour coordinates) is present |
| `vdim` | number | yes | F | embedding dimension of `vectors` (0 when absent) |
| `notesBlock` | number | yes | F | cards per gzipped notes block (currently 512); readers must use this, never a hard-coded constant |
| `buffers` | array | yes | F | the buffer manifest, below |

There is exactly **one** format: v2.2, this document. (Earlier internal layouts kept these
per-node/per-region/view fields in the meta JSON; every shipping and fixture `.eido` was
regenerated when v2.2 landed, and the codec neither reads nor writes anything older.)

### The buffer manifest

`meta.buffers` is an ordered list of specs:

```json
{ "key": "xy", "type": "f32", "length": 48, "offset": 0 }
```

- `type` is one of `f32` (4-byte little-endian IEEE float), `i32` (4-byte little-endian signed
  int), `f16` (2-byte IEEE half-precision float), `u8` (raw bytes), `f64` (8-byte little-endian
  IEEE double — the generic column store's numeric block; temporal values are epoch milliseconds,
  which f32 would round by minutes).
- `length` is the element count (not bytes); byte size = `length × width` where width is
  4/4/2/1/8 respectively.
- `offset` is the byte offset into the buffers region. Each buffer starts 4-byte aligned; the
  encoder inserts zero padding between buffers to keep that true.

Ragged (variable-row-length) data uses a pair of buffers: `<name>_v` holds all values
concatenated, `<name>_o` holds `n+1` offsets, so row `i` = `vals[offs[i] .. offs[i+1]]`.

Every buffer key the encoder can emit:

| key | type | required | stratum | meaning |
|---|---|---|---|---|
| `xy` | f32 | yes | C | 2D layout, row-major `n × 2` |
| `xyz` | f32 | yes | C | 3D layout, row-major `n × 3` — an independent fit, not the 2D map with depth (see `xyzAgree`) |
| `hub` | f32 | yes | C | per-node k-nearest-neighbor in-degree (influence) |
| `cluster` | i32 | yes | C | per-node region index at the default grain |
| `scores` | f32 | yes | C | axis-major flat `axes.length × n`: rank-normalized 0..100 axis positions; axis `ai`'s value for node `i` is at `ai*n + i` |
| `rawScores` | f32 | no | C | same layout: raw PCA projections (the "honest" un-ranked view of each axis) |
| `nbr_v` / `nbr_o` | i32 | yes | C | ragged: per-node nearest-neighbor node indices |
| `levels_v` / `levels_o` | i32 | if `hasLevels` | C | ragged: per cluster-ladder level, per-node region assignment |
| `cite_v` / `cite_o` | i32 | if `hasCite` | C | ragged: per-node intra-corpus citation edges (node indices) |
| `vectors` | f16 | if `hasVectors` | C | card embedding matrix, row-major `n × vdim`; node `i`'s vector is elements `i*vdim .. (i+1)*vdim` |
| `color` | f16 | if `hasColor` | C | per-card colour coordinates, row-major `n × 2`, unit-disc values in [-1, 1]: a dedicated 2D projection of the card vectors (independent of `xy`/`xyz`) that data colours derive from — region/categorical hue = member-centroid angle |
| `notes_z` | u8 | yes | S | concatenated gzip blocks of placement notes (below) |
| `notes_zi` | i32 | yes | S | block byte offsets into `notes_z` (`blockCount + 1` entries) |
| `notes_o` | i32 | yes | S | each row's byte offset within its *decompressed* block (`n` entries) |
| `prow_v` | u8 | yes | S | ragged UTF-8 values: one JSON row per node (the per-doc columns; layout below) |
| `prow_o` | i32 | yes | S | `n+1` row byte offsets into `prow_v` |
| `rrow_v` | u8 | yes | C | ragged UTF-8 values: one JSON row per region label, region blurb, default-level RegionDef, then ghost (segment order and counts below) |
| `rrow_o` | i32 | yes | C | row byte offsets into `rrow_v` |
| `vrow_v` | u8 | yes | W | ragged UTF-8 values: one JSON row per saved view — its settings plus id-list counts, with the id lists themselves in `vid_*` (layout below) |
| `vrow_o` | i32 | yes | W | `viewsN+1` row byte offsets into `vrow_v` |
| `vid_v` | u8 | yes | W | ragged UTF-8 values: one RAW card id per row (no JSON) — the views' selection and derived-axis id lists, concatenated in file order |
| `vid_o` | i32 | yes | W | row byte offsets into `vid_v` |
| `mcolnum_v` | f64 | if `mcols` | S | the generic column store's numeric block: every scalar/temporal column from `mcols` (in descriptor order), column-major — numeric column `c`'s value for node `i` is at `c*n + i`; NaN = absent |
| `mcolrow_v` | u8 | if `mcols` | S | ragged UTF-8 values: one JSON row per node per categorical/boolean column from `mcols` (in descriptor order, `n` consecutive rows per column) — a string (`string[]` when `multi`) or boolean; `null` = absent |
| `mcolrow_o` | i32 | if `mcols` | S | row byte offsets into `mcolrow_v` |

### f16 encoding

`vectors` is stored as IEEE 754 half-precision (binary16), little-endian, converted from
float32 with round-to-nearest-even (subnormals, infinity, and NaN handled per the standard).
This was measured lossless for cosine-similarity ranking at half the bytes. Any standard
half-float conversion reads it; `src/eido-container.ts` has a dependency-free reference
implementation (`f32ToF16`/`f16ToF32`).

### The notes blocks

The per-card placement notes are the file's largest text section (measured 31.8 MB of a
42.2 MB meta on a 13,830-doc corpus) and mostly go unread in a session, so they are stored in
independently-gzipped blocks that a reader can inflate lazily:

- Cards are grouped into blocks of `meta.notesBlock` consecutive cards (currently 512 — an
  engineering constant chosen so a block is ~1 MB decompressed; always read it from meta).
- Each card's notes object (`{axisKey: noteText}`) is serialized as UTF-8 JSON; a block's rows
  are concatenated and the whole block gzipped.
- `notes_z` = all gzipped blocks concatenated. Block `b` = bytes
  `notes_zi[b] .. notes_zi[b+1]` of `notes_z`.
- Card `i` lives in block `floor(i / notesBlock)`. After gunzipping that block, card `i`'s
  JSON is bytes `notes_o[i] .. end` of the decompressed block, where `end` is `notes_o[i+1]`
  unless `i` is the last card of its block (or of the file), in which case `end` is the
  decompressed block's length.

A reader that does not care about laziness can inflate every block, split by offsets, and
parse each row.

### The JSON row buffers

Three ragged UTF-8 buffers carry everything textual that scales with the corpus or the user's
work, one independently-parseable JSON row at a time (row `i` of `<name>_v` is bytes
`<name>_o[i] .. <name>_o[i+1]`, parsed as one JSON document). This is what keeps the meta parse
bounded and lets a reader expand a huge file incrementally.

- **`prow_*`** — `n` rows; row `i` is a 12-element JSON array for node `i`:
  `[id, title, core, url, source, siteName, author, tags, date, read, folder, citec]`.
  Optional slots hold `null` when the value is absent; `meta.cols` says which columns are
  present *at all* (a column marked `false` is absent from the contract, not an all-null
  column).
- **`rrow_*`** — four consecutive segments, each row one JSON value:
  1. region **labels**: for each level `l`, `levelCounts[l]` rows (JSON strings) — present only
     when `hasLevelLabels`;
  2. region **blurbs**: for each level `l`, `blurbCounts[l]` rows (JSON string or `null`) —
     present only when `hasBlurbs`, and independent of the labels segment;
  3. `clustersN` default-level **RegionDef** rows: `{c, n, label, blurb?, cx?, cy?}`;
  4. `ghostsN` **ghost** rows (`{title, arxiv, url, n, core, xy, sim}`) — present only when
     `hasGhosts`.
- **`vrow_*`** — `viewsN` rows, each one saved view `{name, created, state, __selN, __derN}`
  (present only when `hasViews`). The view's uncapped card-id lists are NOT in this JSON: the
  row carries only counts — `__selN` (id count of `state.selection`; `null` = selection absent)
  and `__derN` (per `state.derived` entry, its `ids` count; `null` = that entry carries no ids)
  — so each view row parses in time bounded by its own small settings.
- **`vid_*`** — the views' id lists, one RAW UTF-8 card id per ragged row (offsets delimit; no
  JSON, no quoting). Ids appear in file order: for each view in `vrow_*` order, first its
  `__selN` selection ids, then each derived entry's `__derN[k]` ids. A reader reassembles by
  consuming rows sequentially; the counts always sum to the total row count of `vid_*`.

### Versions

- There is exactly **one** format — the one in this document (v2.2). Older internal layouts
  existed during development and every shipping/fixture `.eido` was regenerated when this one
  landed; the codec neither reads nor writes anything else.
- `version` is a human capability signal. Readers detect features by presence: the `has*`
  flags, whether a buffer key exists in the manifest, whether a meta key exists.
- **Lite emits** omit `vectors` (`hasVectors: false`, `vdim: 0`). Such a file still renders and
  filters fully, but nothing that needs the embedding space works offline: no *descend*
  (re-laying-out a subset in its own space), no *derive* / semantic-query axes (embedding a
  query or examples into the card space), no new-point placement. Re-adding those requires
  re-embedding the cards (card basis) with the embedder named in `derivedBy.embedder`.

### Writing a valid file (checklist for another tool)

1. Build the meta object with at minimum the required keys above. Nothing that grows with `n`
   or with saved work belongs in it.
2. Encode required buffers (`xy`, `xyz`, `hub`, `cluster`, `scores`, `nbr_v`, `nbr_o`, the
   notes blocks, and `prow_v`/`prow_o` with one 12-element row per node); set `has*` flags for
   the optional ones you include.
3. Encode `rrow_v`/`rrow_o` (labels · blurbs · RegionDefs · ghosts, in that order, with the
   matching `levelCounts`/`blurbCounts`/`clustersN`/`ghostsN`), `vrow_v`/`vrow_o` (one row per
   saved view, `viewsN` total, id lists replaced by `__selN`/`__derN` counts) and
   `vid_v`/`vid_o` (the extracted ids, raw utf8, in view order). Emit the presence flags so
   empty-but-present lists (`[]`) survive as `[]`.
4. Lay buffers out in the buffers region 4-byte aligned; record `{key, type, length, offset}`
   for each in `meta.buffers`.
5. Write magic + u32 metaLen + meta JSON (padded to 4 bytes) + buffers region.
6. Gzip the whole thing.

### View state (stratum 3 detail)

Each saved view's `state` is the complete description of one way of looking (the same object
the app's URL encodes, but uncapped — full id lists, no length limits). All keys optional:

`layout` ("mde" | "axes" | "orbit" | "axes3d"), `channels` (visual channel → dimension key, for
channels color/size/x/y/z/scrub/sort), `grain` (cluster ladder level), `dimProps` (per
dimension: `{norm: "honest"|"rank", invert}`), `window` (`{lo?, hi?}` scrub window), `region`
(isolated region id), `facet` (isolated categorical value), `find` (substring filter), `card`
(open card id), `queries` (semantic-query texts, re-embedded on open), `derived`
(`{label, key, ids}[]` — user-derived dimensions with full example-card ids), `selection` (held
set, full card ids), `camera` (`{target, zoom, rot?, rotX?}`), and toggles `cite`, `ghosts`,
`labels`, `deckOpen`, `deckQ`, `deckUnread`.
