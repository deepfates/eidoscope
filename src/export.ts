// The PURE half of every outbound flow (eid-4ii9) — node-free, so BOTH hosts share one emit and neither
// forks the logic: the CLI's sinks (src/sink.ts) write these entries to a directory; the app's Export
// menu zips/downloads the very same entries (viewer/src/App.svelte). Everything here flows FROM THE
// CARDS in the MapContract — title + core + placements + the map's judgment — never from side data.
import type { MapContract } from "./schema.ts";

// PROVENANCE THAT TRAVELS (Hac-3r74). `provenance.source` describes the corpus; it must not describe the
// machine that built it. Maps built by an older CLI recorded an absolute path there, so every published
// .eido carried its builder's home directory — visible in the about panel of a public web page, and
// copied onward into every vault manifest and parts manifest exported from it. The emit side no longer
// writes paths, but files already in the world cannot be un-published, so every place that DISPLAYS or
// RE-EMITS this field goes through here. Non-paths pass through untouched: the in-page and HuggingFace
// connectors write portable descriptions that are worth reading in full.
export const portableSource = (s?: string): string | undefined =>
  !s ? s : /^(\/|~\/|[A-Za-z]:[\\/])/.test(s) ? s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined : s;

// base64 without assuming a host: Buffer where it exists (Bun/Node), chunked btoa in the browser.
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Inline a .eido payload into a built viewer shell → ONE self-contained offline HTML. The shell is
// viewer/dist/index.html (already JS/CSS-inlined); a plain <script> in <head> runs during parse, before
// the app's deferred module script reads window.__EIDO_DATA__ (viewer/src/loader.ts prefers it over fetch).
export function injectEido(shell: string, eido: Uint8Array): string {
  // NOTE: this module is BUNDLED INTO the app's own inline <script> (the single-file build), so NO
  // HTML sentinel may appear as a literal in the source. A raw `</script>` would end the app's script
  // element outright; a raw `<script` flips the HTML tokenizer into the double-escaped state; and even
  // a raw `"</head>"` becomes the FIRST match for any later naive `.replace("</head>", …)` over the
  // built page, splicing a payload into the middle of the app's JS (measured: the offline single-file
  // build died with a SyntaxError mid-payload). Every tag string is assembled at runtime, via
  // decodeURIComponent — because the minifier constant-folds both "<"+"script>" AND
  // String.fromCharCode(60)+"script>" right back into the literal this comment forbids (measured
  // twice on the vite build; decodeURIComponent it leaves alone).
  const LT = decodeURIComponent("%3C");   // "<", opaque to constant folding
  const SCRIPT_OPEN = LT + "script>", SCRIPT_END = LT + "/script>", HEAD_END = LT + "/head>";
  // strip any payload the shell already carries (re-exporting from a single-file build must not stack two)
  const clean = shell.replace(new RegExp(SCRIPT_OPEN + "window\\.__EIDO_DATA__=[^<]*" + SCRIPT_END.replace("/", "\\/"), "g"), "");
  const inject = `${SCRIPT_OPEN}window.__EIDO_DATA__=${JSON.stringify(toBase64(eido))}${SCRIPT_END}`;
  return clean.includes(HEAD_END) ? clean.replace(HEAD_END, inject + HEAD_END) : inject + clean;
}

export type ExportEntry = { name: string; text: string };

const yq = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';

// Markdown-vault entries: one .md per card, frontmatter carrying the map's judgment about that card
// (id, per-axis scores, region, url), plus the manifest that keeps identity through the round trip
// (folderSource reads it and names the re-ingested map after the SOURCE map). The vault is itself a
// valid corpus — export, edit/cull in any markdown tool, re-ingest: the curation loop, no proprietary step.
export function vaultEntries(D: MapContract): { manifest: ExportEntry; cards: ExportEntry[] } {
  const manifest: ExportEntry = {
    name: "eidoscope-vault.json",
    text: JSON.stringify({
      eidoscope: "vault", title: D.provenance?.title, source: portableSource(D.provenance?.source),
      exported: Date.now(), count: D.ids.length,
    }, null, 2) + "\n",
  };
  const cards: ExportEntry[] = [];
  const used = new Set<string>();
  const di = D.di ?? 0;
  const regionLabel = (i: number) => {
    const c = D.cluster[i];
    return D.levelLabels?.[di]?.[c] ?? D.clusters?.[c]?.label;
  };
  for (let i = 0; i < D.ids.length; i++) {
    let base = D.ids[i].replace(/[^A-Za-z0-9._-]+/g, "_") || "card";
    if (used.has(base)) { let k = 2; while (used.has(base + "-" + k)) k++; base = base + "-" + k; }
    used.add(base);
    const lines = ["---", `id: ${yq(D.ids[i])}`, `title: ${yq(D.titles[i] || D.ids[i])}`];
    const url = D.urls?.[i]; if (url) lines.push(`url: ${yq(url)}`);
    const region = regionLabel(i); if (region != null) lines.push(`region: ${yq(region)}`);
    lines.push("axes:");
    for (const a of D.axes) lines.push(`  ${a.key}: ${D.scores[a.key]?.[i] ?? ""}`);
    lines.push("---", "", D.cores[i] || "");
    const notes = D.notes[i] || {};
    const placed = D.axes.filter((a) => notes[a.key]);
    if (placed.length) {
      lines.push("", "## Placements", "");
      for (const a of placed) lines.push(`- **${a.name}** (${a.low} ⇄ ${a.high}): ${notes[a.key]}`);
    }
    cards.push({ name: base + ".md", text: lines.join("\n") + "\n" });
  }
  return { manifest, cards };
}

// Deck JSONL: one line per card, the same card-shaped rows the pipeline's deck.jsonl speaks
// (src/card.ts Card), reconstructed from the contract — id/title/metadata/core + per-axis
// { note (the placement), score (the exact projection) }. Fed from the cards, nothing else.
export function deckJSONL(D: MapContract): string {
  const rows: string[] = [];
  for (let i = 0; i < D.ids.length; i++) {
    const axes: Record<string, { note: string; score: number }> = {};
    for (const a of D.axes) axes[a.key] = { note: D.notes[i]?.[a.key] ?? "", score: D.scores[a.key]?.[i] ?? 50 };
    rows.push(JSON.stringify({
      id: D.ids[i], title: D.titles[i],
      date: D.dates?.[i], url: D.urls?.[i], source: D.sources?.[i], siteName: D.siteNames?.[i],
      author: D.authors?.[i], tags: D.tags?.[i],
      core: D.cores[i], axes,
    }));
  }
  return rows.join("\n") + "\n";
}

// ── SEPARABLE PARTS (eid-ncrq) ───────────────────────────────────────────────────────────────────────
// deepfates' ask, verbatim: "the embeddings are one thing that we're storing, and the metadata about how
// to display them is another, and the LLM generated structure/text is another one. And so we should be
// able to export things separately. Maybe as separate files within a single folder, or a compressed
// something."
//
// So the split follows HIS three, which are also the .eido's three strata (docs/ARCHITECTURE.md):
//   cards.jsonl   — the LLM-generated structure and text. SOURCE TRUTH; not recomputable.
//   vectors.f32   — the embeddings. A cache: expensive, re-derivable from the cards with a model.
//   geometry.json — how to display them: positions, regions, the grain ladder, colour coordinates, axes.
//                   Also a cache, re-derivable from the vectors.
//   views.json    — the work: named views, selections, derived axes. Only written when there is some.
//   manifest.json — provenance, how it was derived, and what each file holds, so the folder is legible
//                   without this code.
//
// This is EXPORT only, and deliberately so: writing the parts out is additive and changes no contract.
// Whether a .eido may be OPENED in parts is a different question (it changes what "a file" means) and
// is deepfates'. Nothing here presumes that answer.
export type PartsEntry = { name: string; text?: string; bytes?: Uint8Array };

export function separableParts(D: MapContract): PartsEntry[] {
  const n = D.ids.length;
  const out: PartsEntry[] = [];

  // 1. THE CARDS — source truth. Same row shape as deckJSONL, which is already the card-as-a-record
  //    format; one format for "a card outside the file", not two that drift.
  out.push({ name: "cards.jsonl", text: deckJSONL(D) });

  // 2. THE EMBEDDINGS — raw little-endian f32, row-major, n × dim. A plain buffer any tool can read
  //    (numpy fromfile, torch frombuffer) rather than a bespoke encoding; the shape is in the manifest.
  if (D.vectors?.data?.length) {
    const v = D.vectors;
    out.push({ name: "vectors.f32", bytes: new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength).slice() });
  }

  // 3. HOW TO DISPLAY THEM — positions, regions, ladder, colour coordinates, axes and their scores.
  out.push({ name: "geometry.json", text: JSON.stringify({
    ids: D.ids,                       // so every array here can be joined back to a card without guessing order
    xy: D.xy, xyz: D.xyz,
    cluster: D.cluster, k: D.k, levels: D.levels, counts: D.counts,
    colorCoords: D.colorCoords,
    axes: D.axes, scores: D.scores, rawScores: D.rawScores,
    metaFields: D.metaFields, cols: D.cols,
  }, null, 1) });

  // 4. THE WORK — only when there is some. An empty views.json would imply work that isn't there.
  if (D.views?.length) out.push({ name: "views.json", text: JSON.stringify(D.views, null, 1) });

  // 5. THE MANIFEST — last, because it describes the others. Says what each file is IN WORDS, so someone
  //    opening the folder cold does not have to read this source to understand it.
  out.push({ name: "manifest.json", text: JSON.stringify({
    format: "eidoscope-parts/1",
    provenance: { ...D.provenance, source: portableSource(D.provenance?.source) }, derivedBy: D.derivedBy,
    cards: n,
    files: {
      "cards.jsonl": `${n} cards, one JSON object per line — the LLM's restatement and per-axis placements. Source truth: everything else is derived from these.`,
      ...(D.vectors?.data?.length ? { "vectors.f32": `${n} × ${D.vectors.dim} float32, little-endian, row-major, row i = card i in cards.jsonl. The card embeddings.` } : {}),
      "geometry.json": "positions (xy, xyz), region assignment and the grain ladder, colour coordinates, discovered axes and their per-card scores. All re-derivable from the vectors.",
      ...(D.views?.length ? { "views.json": `${D.views.length} saved view(s) — named camera/channel/filter states.` } : {}),
    },
  }, null, 1) });

  return out;
}
