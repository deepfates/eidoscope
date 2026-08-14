#!/usr/bin/env bun
// RELATEDNESS EVAL (eid-pkqu) — is a map's neighbourhood structure actually RIGHT, by a judgement that
// is not our own?
//
// Everything else we measure about a map is internal: determinism, kNN recall, 2D-vs-3D agreement,
// layout-vs-layout preservation. All of those can be perfect while the map is nonsense, because they
// only ever compare the instrument to itself. This tool compares it to EXTERNAL VERIFIERS — labels a
// human or an institution attached to the documents for their own reasons, before we ever embedded
// anything: Pitchfork's editorial genre tags and review scores, the artist a record belongs to,
// Wikipedia's category graph, Wikidata's "instance of", a vendor's price list.
//
// THE MEASURE, per (corpus × verifier × space):
//   precision@k — of a card's k nearest neighbours IN THAT SPACE, what fraction share its label —
//   against the RANDOM-PAIR baseline for the same corpus and the same verifier. The absolute number is
//   meaningless on its own (a 9-value genre label gives ~0.22 by chance; a 9,360-value artist label
//   gives ~0.0001). The LIFT over baseline is the finding. Scalar verifiers (a review score) are
//   scored as mean |Δ| between neighbours vs mean |Δ| between random pairs, so lift stays "bigger is
//   better" in both cases.
//
// NEVER BLENDED. Every cell is reported on its own row. There is no overall score, on purpose: each
// verifier is biased toward something different (each one says what, below and in docs/EVAL.md), and
// an average of biased numbers is just a number whose bias you can no longer name.
//
// THERE IS NO LLM JUDGE HERE, also on purpose. The decisions this harness exists to re-examine were
// made on an LLM triplet judge; an LLM's opinion about whether two cards are related is downstream of
// the same modelling we are trying to audit. Use one as a smoke test if you like — never as a verdict.
//
//   bun bin/eval-relatedness.ts                          # every corpus with a verifier, at k=10
//   bun bin/eval-relatedness.ts out/pitchfork/pitchfork.eido --k 10
//   bun bin/eval-relatedness.ts <eido> --layout landmark=/tmp/xy.json   # score an ALTERNATIVE layout
//   bun bin/eval-relatedness.ts <eido> --fetch           # (re)build the external verifier sidecars
//   bun bin/eval-relatedness.ts <eido> --json report.json
//
// Sidecar verifiers (the ones that come from outside the repo — Wikipedia, Wikidata, a vendor
// registry) are cached under eval/verifiers/<corpus>.<verifier>.json and committed, so a re-run is
// offline and reproducible. `--fetch` is the only thing that touches the network or the source dirs.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMap } from "../src/mapbin.ts";
import type { MapContract } from "../src/schema.ts";
import { nodeKnn, layoutKnn, embedDocs } from "../src/map.ts";
import { folderSource } from "../src/corpus.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const VDIR = join(REPO, "eval", "verifiers");

// ── the verifier registry ────────────────────────────────────────────────────────────────────────────
// A verifier is a per-document label from OUTSIDE the map. `bias` is not documentation garnish: every
// one of these leans somewhere, and a reader of the table needs the lean stated next to the number.
export type LabelSet = { kind: "cat"; vals: (string[] | undefined)[] } | { kind: "num"; vals: (number | undefined)[] };
type Verifier = {
  key: string;
  label: string;
  bias: string;
  // read from the .eido itself (a metadata column the corpus source carried), or from a sidecar
  read?: (D: MapContract) => LabelSet;
  // (re)build the sidecar — network or source-dir; only run under --fetch
  fetch?: (D: MapContract) => Promise<Record<string, string[] | number>>;
  kind?: "cat" | "num"; // sidecar verifiers declare their kind here
};

const mcol = (D: MapContract, key: string) => D.cols?.find((c) => c.key === key);
const catCol = (key: string) => (D: MapContract): LabelSet => {
  const c = mcol(D, key);
  const vals = (c?.values ?? D.ids.map(() => undefined)).map((v) =>
    v === undefined || v === null || v === "" ? undefined : Array.isArray(v) ? (v as string[]) : [String(v)]);
  return { kind: "cat", vals };
};
const numCol = (key: string) => (D: MapContract): LabelSet => {
  const c = mcol(D, key);
  const vals = (c?.values ?? D.ids.map(() => undefined)).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined));
  return { kind: "num", vals };
};
const nativeCat = (pick: (D: MapContract) => (string | undefined | null)[] | undefined) => (D: MapContract): LabelSet => {
  const src = pick(D) ?? D.ids.map(() => undefined);
  return { kind: "cat", vals: src.map((v) => (v ? [String(v)] : undefined)) };
};

// ── external fetchers ────────────────────────────────────────────────────────────────────────────────
const wikiTitle = (url: string) => decodeURIComponent(url.split("/wiki/")[1] ?? "").replace(/_/g, " ");
// Wikipedia hangs a lot of MAINTENANCE categories off every article ("Pages using infobox …", "Coordinates
// on Wikidata", "… stubs"). Those are facts about the wikitext, not about the subject, and they'd let a
// map score by article plumbing. Dropped by this prefix/suffix list — stated here because the filter is
// part of what the verifier means.
const ADMIN = /^(Pages |Articles |Article |Commons |Coordinates |Webarchive|CS1|Use |Wikipedia|Short description|Non-free|All |Wikidata|Interlanguage|Redirect|Template|Portal|Infobox|Good articles|Very good articles)|( stubs|with Wikidata| errors| templates| pages)$/i;
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const api = async (url: string) => {
  for (let t = 0; t < 4; t++) {
    const r = await fetch(url, { headers: { "user-agent": "eidoscope-eval/1.0 (https://github.com/deepfates/eidoscope)" } });
    if (r.ok) return r.json() as Promise<any>;
    await new Promise((s) => setTimeout(s, 500 * (t + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
};

// Simple-Wikipedia categories + the article's Wikidata item, one 50-title batch at a time. Neither is in
// the local article text (the vault article is title + frontmatter + a couple of sentences), so this is
// a judgement made entirely outside anything the map was built from.
async function fetchWikiCats(D: MapContract): Promise<Record<string, string[] | number>> {
  const out: Record<string, string[]> = {}, qid: Record<string, string> = {};
  const byTitle = new Map<string, string>();  // wiki title -> card id
  D.ids.forEach((id, i) => { const t = wikiTitle(D.urls?.[i] ?? ""); if (t) byTitle.set(t, id); });
  for (const batch of chunk([...byTitle.keys()], 50)) {
    const j = await api(`https://simple.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=categories|pageprops&ppprop=wikibase_item&cllimit=500&titles=${batch.map(encodeURIComponent).join("|")}`);
    const norm = new Map<string, string>();          // API-normalized/redirected title -> our title
    for (const n of j.query?.normalized ?? []) norm.set(n.to, n.from);
    for (const r of j.query?.redirects ?? []) norm.set(r.to, norm.get(r.from) ?? r.from);
    for (const p of Object.values<any>(j.query?.pages ?? {})) {
      const ours = norm.get(p.title) ?? p.title, id = byTitle.get(ours);
      if (!id) continue;
      const cats = (p.categories ?? []).map((c: any) => c.title.replace(/^Category:/, "")).filter((c: string) => !ADMIN.test(c));
      if (cats.length) out[id] = cats;
      if (p.pageprops?.wikibase_item) qid[id] = p.pageprops.wikibase_item;
    }
  }
  writeFileSync(join(VDIR, `${corpusKeyOf(D)}.wikidata_qid.json`), JSON.stringify(qid));  // input to the P31 fetch
  return out;
}
// Wikidata P31 ("instance of") — the entity's TYPE in a separate knowledge base: human, city, film,
// species. Needs the qid map written by the category fetch above.
async function fetchWikidataP31(D: MapContract): Promise<Record<string, string[] | number>> {
  const qf = join(VDIR, `${corpusKeyOf(D)}.wikidata_qid.json`);
  if (!existsSync(qf)) throw new Error("run the wikicat fetch first (it writes the qid map)");
  const qid: Record<string, string> = JSON.parse(readFileSync(qf, "utf8"));
  const ids = Object.entries(qid), out: Record<string, string[]> = {}, need = new Set<string>();
  const claims: Record<string, string[]> = {};
  for (const batch of chunk(ids, 40)) {
    const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${batch.map(([, q]) => q).join("|")}`);
    for (const [id, q] of batch) {
      const cs = (j.entities?.[q]?.claims?.P31 ?? []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      if (cs.length) { claims[id] = cs; cs.forEach((c: string) => need.add(c)); }
    }
  }
  // resolve the type Q-ids to readable English labels, so the report says "human" not "Q5"
  const names: Record<string, string> = {};
  for (const batch of chunk([...need], 40)) {
    const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${batch.join("|")}`);
    for (const q of batch) names[q] = j.entities?.[q]?.labels?.en?.value ?? q;
  }
  for (const [id, cs] of Object.entries(claims)) out[id] = cs.map((q) => names[q] ?? q);
  return out;
}
// OpenRouter's own price list for each model, log10-bucketed by prompt price ($/Mtok). Read from the
// registry's metadata records, NOT from the model-card document: the .md carries context window and
// modalities in its frontmatter, but never the price. What a vendor charges is a market judgement made
// with no reference to how the card reads.
async function fetchModelPrice(D: MapContract): Promise<Record<string, string[] | number>> {
  const out: Record<string, string[]> = {};
  D.ids.forEach((id, i) => {
    const doc = D.urls?.[i]?.startsWith("file://") ? fileURLToPath(D.urls[i]!) : undefined;
    if (!doc || !existsSync(doc)) return;
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(doc, "utf8"))?.[1] ?? "";
    const rec = /metadata_record:\s*"?([^"\n]+)"?/.exec(fm)?.[1];
    if (!rec) return;
    const path = join(dirname(doc), rec);
    if (!existsSync(path)) return;
    const m = JSON.parse(readFileSync(path, "utf8"));
    const p = Math.max(...(m.openrouter?.routes ?? []).map((r: any) => parseFloat(r?.pricing?.prompt ?? "NaN")).filter((x: number) => Number.isFinite(x) && x > 0), 0);
    if (!p) return;
    const perM = p * 1e6;                                  // $ per million prompt tokens
    const tier = perM < 0.1 ? "<$0.10" : perM < 0.5 ? "$0.10–0.50" : perM < 2 ? "$0.50–2" : perM < 10 ? "$2–10" : "$10+";
    out[id] = [tier];
  });
  return out;
}

// Open Library's librarian-assigned subject headings, read off the rendered source documents. Weakly
// independent ON PURPOSE and flagged as such: the subjects are printed in the document the card model
// read. Kept because a weak verifier whose weakness is stated is still evidence; dropped from any
// conclusion that a strong verifier can carry instead.
async function fetchOpenLibrarySubjects(D: MapContract): Promise<Record<string, string[] | number>> {
  const out: Record<string, string[]> = {};
  D.ids.forEach((id, i) => {
    const u = D.urls?.[i];
    if (!u?.startsWith("file://")) return;
    const p = fileURLToPath(u);
    if (!existsSync(p)) return;
    const m = /^\*\*subjects\*\*:\s*(\[[^\n]*\])/m.exec(readFileSync(p, "utf8"));
    if (!m) return;
    try { const arr = JSON.parse(m[1]); if (Array.isArray(arr) && arr.length) out[id] = arr.map(String); } catch { /* malformed row: no label */ }
  });
  return out;
}

const sidecar = (key: string, label: string, bias: string, kind: "cat" | "num", fetcher: Verifier["fetch"]): Verifier => ({ key, label, bias, kind, fetch: fetcher });

// corpus key = the .eido's basename (what `out/<slug>/<slug>.eido` already names it)
let CORPUS_KEY = "";
const corpusKeyOf = (_D: MapContract) => CORPUS_KEY;

const REGISTRY: Record<string, Verifier[]> = {
  // ── PITCHFORK: 19,299 reviews, four editorial facts carried in the source frontmatter ─────────────
  pitchfork: [
    { key: "genre", label: "Pitchfork genre tag", read: catCol("genre"),
      bias: "Editorial, coarse (9 buckets → ~0.22 by chance) and TOPICAL: genre words appear in the prose and in the source frontmatter the card model read, so this rewards a map that retained subject vocabulary. It is the friendliest verifier here." },
    { key: "artist", label: "same artist", read: catCol("artist"),
      bias: "Very sparse (9,360 artists over 19,299 reviews → baseline ~1e-4), so lift numbers are large by construction. Rewards proper-noun retention as much as musical relatedness: the artist's name is in the review text." },
    { key: "author", label: "same reviewer", read: nativeCat((D) => D.authors),
      bias: "A staffing fact, not a music fact — but critics have beats, so it partly re-measures genre and era. Also present in the source frontmatter." },
    { key: "score", label: "review score (0–10)", read: numCol("score"),
      bias: "The one verifier with no topical channel at all: a human verdict on quality. A map is NOT expected to group by it — lift ≈ 1 here is information about the world (good and bad records sound alike), not a defect." },
  ],
  // ── SIMPLE WIKIPEDIA: the local article is a stub; both verifiers come from outside it ────────────
  "simple-wikipedia-400": [
    sidecar("wikicat", "shared Wikipedia category", "Editor-curated and hierarchical: mixes topic ('Cities in Switzerland') with biography bookkeeping ('1933 births'), so an entity-type-ish grouping scores well. Maintenance categories are filtered out (see ADMIN in this file). Not present in the local article text.", "cat", fetchWikiCats),
    sidecar("wikidata_p31", "same Wikidata type (P31)", "Entity TYPE from a separate knowledge base (human / city / film). Extremely coarse — 'human' swallows a third of any Wikipedia sample — so the baseline is high and the ceiling low; it credits a map for sorting people from places, not for sorting people from each other.", "cat", fetchWikidataP31),
  ],
  // ── OPENROUTER MODEL CARDS: one in-document label, one registry label ─────────────────────────────
  "openrouter-model-cards": [
    { key: "vendor", label: "vendor (folder)", read: nativeCat((D) => D.folders),
      bias: "THE KNOWN-BAD ONE, kept in deliberately as a control: the vendor name is in the title, the prose and the frontmatter of every card, and vendors write to a house template. This is the 'folders favour format' bias the ticket warns about, quantified rather than assumed." },
    sidecar("price_tier", "OpenRouter price tier", "From the vendor's price list in the registry metadata, never in the card text. Coarse (5 buckets) and correlated with model size and recency, so it partly re-measures 'frontier vs small'.", "cat", fetchModelPrice),
  ],
  // ── corpora with NO usable external verifier — listed so their absence is on the record ───────────
  "aesop-fables": [],
  "graham-essays": [],
  "open-library-300": [
    sidecar("subject", "Open Library subject heading", "Librarian-assigned subject headings — a real external judgement, but they are printed IN the rendered document the card model read, so independence is WEAK. Also long-tailed, so its baseline is near zero and its lifts look impressive by construction.", "cat", fetchOpenLibrarySubjects),
  ],
};

// ── the measure ──────────────────────────────────────────────────────────────────────────────────────
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export type Cell = { corpus: string; space: string; verifier: string; k: number; n: number; coverage: number; score: number; base: number; lift: number; metric: "prec@k" | "mean|Δ|" };

// precision@k over a neighbour list, plus the random-pair baseline for the same label set. Unlabelled
// neighbours are dropped from the denominator (else a sparsely-labelled corpus looks worse for a reason
// that has nothing to do with the map); `coverage` reports how much of the corpus carries the label.
export function scoreSpace(corpus: string, space: string, nbr: number[][], L: LabelSet, k: number, pairs: number): Cell | null {
  const idx: number[] = [];
  L.vals.forEach((v, i) => { if (v !== undefined && !(Array.isArray(v) && v.length === 0)) idx.push(i); });
  if (idx.length < 10) return null;
  const labelled = new Uint8Array(L.vals.length); idx.forEach((i) => (labelled[i] = 1));
  const sets = L.kind === "cat" ? (L.vals as (string[] | undefined)[]).map((v) => (v ? new Set(v) : undefined)) : undefined;
  const shares = (i: number, j: number) => {
    if (L.kind === "num") return Math.abs((L.vals[i] as number) - (L.vals[j] as number));
    const a = sets![i]!, b = sets![j]!;
    for (const x of a) if (b.has(x)) return 1;
    return 0;
  };
  let sum = 0, cnt = 0;
  for (const i of idx) {
    const row = nbr[i] ?? [];
    let s = 0, c = 0;
    for (const j of row.slice(0, k)) { if (j === i || !labelled[j]) continue; s += shares(i, j); c++; }
    if (c) { sum += s / c; cnt++; }
  }
  const obs = sum / (cnt || 1);
  // baseline: seeded random pairs of DISTINCT labelled nodes, same shares() test
  const rnd = mulberry32(0x5eed);
  let bs = 0;
  for (let t = 0; t < pairs; t++) {
    const i = idx[Math.floor(rnd() * idx.length)];
    let j = idx[Math.floor(rnd() * idx.length)];
    if (i === j) { j = idx[(idx.indexOf(i) + 1) % idx.length]; }
    bs += shares(i, j);
  }
  const base = bs / pairs;
  return { corpus, space, verifier: "", k, n: cnt, coverage: idx.length / L.vals.length,
    score: obs, base, lift: L.kind === "num" ? base / (obs || 1e-9) : obs / (base || 1e-9),
    metric: L.kind === "num" ? "mean|Δ|" : "prec@k" };
}

// ── spaces ───────────────────────────────────────────────────────────────────────────────────────────
// "cards" = the card-vector neighbourhood (what the map IS, before any projection); "xy" = the 2D layout
// the reader actually looks at. Extra layouts (--layout name=file.json, a bare n×2 array) are scored the
// same way, which is how one construction gets compared to another on the same verifiers.
// THE COMPARISON THIS HARNESS WAS MISSING (2026-08-14). Every number it produced measured the CARD space
// against the world and found real lift — and never once asked what the same corpus scores WITHOUT the
// bottleneck. That makes "the cards carry real relatedness" true and "the cards are worth their cost"
// unexamined, which are not the same claim. `--raw <corpus-dir>` embeds the source documents' full text
// with the same MiniLM the pipeline uses and scores that neighbourhood on the same verifiers, so the two
// constructions can be read side by side.
//
// This is deliberately NOT the forbidden move. Routing the shipped geometry around the cards to buy a
// better number is off the table; measuring what the cards cost is the opposite — it is the only way the
// bottleneck's price is ever stated out loud. If raw wins on relatedness, the cards still have a reason
// to exist (they are the readable atoms; a raw map cannot be read at all), and we say the price instead
// of implying there isn't one.
async function rawSpace(D: MapContract, dir: string, k: number): Promise<number[][] | null> {
  const src = folderSource(dir, {});
  const { docs } = await src.load();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const aligned = D.ids.map((id) => byId.get(id));
  const hit = aligned.filter(Boolean).length;
  // Fail loud rather than silently scoring a different corpus: a partial join would quietly compare the
  // card space over 19,299 documents to a raw space over whatever subset happened to match.
  if (hit / D.ids.length < 0.98) throw new Error(`--raw: only ${hit}/${D.ids.length} of the map's ids were found in ${dir} — that is a different corpus, not a comparison`);
  console.error(`raw space: ${hit}/${D.ids.length} ids matched; embedding full text with the pipeline's own embedder…`);
  const embs = await embedDocs(aligned.map((d, i) => d ?? { id: D.ids[i], title: D.titles[i], body: "" } as any));
  const X = embs.map((r) => { const m = Math.sqrt(r.reduce((a, x) => a + x * x, 0)) || 1; return r.map((x) => x / m); });
  return (await nodeKnn(X, k)).idx.map((r) => r.filter((_, t) => t > 0));
}

async function spacesOf(D: MapContract, k: number, extra: Record<string, number[][]>, rawDir?: string) {
  const out: Record<string, number[][]> = {};
  if (D.vectors) {
    // UNIT-NORMALIZE first: the pipeline lays out `embs.map(unit)` and the kNN kernels rank by dot
    // product, so scoring the raw stored rows (norms are ~0.86, not 1) would measure a different
    // neighbourhood than the map's own. Validated against the file's stored `nbr` graph below.
    const n = D.ids.length, dim = D.vectors.dim, X: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = Array.from(D.vectors.data.subarray(i * dim, (i + 1) * dim));
      const m = Math.sqrt(r.reduce((a, x) => a + x * x, 0)) || 1;
      X[i] = r.map((x) => x / m);
    }
    out.cards = (await nodeKnn(X, k)).idx.map((r) => r.filter((_, t) => t > 0));  // rows are self-inclusive
    // CROSS-CHECK the recomputed graph against the one the file shipped with: if they disagree badly,
    // the eval is scoring a space the map never used and every number below is about the wrong thing.
    if (D.nbr?.length) {
      let shared = 0, of = 0;
      // compare like with like: the stored graph carries its own K, so only its first min(k, K) edges
      for (let i = 0; i < n; i++) { const a = new Set(out.cards[i]); for (const j of D.nbr[i].slice(0, k)) { of++; if (a.has(j)) shared++; } }
      const agree = shared / (of || 1);
      if (agree < 0.9) console.error(`WARNING: recomputed card-vector kNN agrees with the file's stored nbr on only ${(agree * 100).toFixed(1)}% of edges`);
      else console.error(`card-vector kNN cross-check: ${(agree * 100).toFixed(1)}% of the file's stored neighbour edges reproduced`);
    }
  } else if (D.nbr?.length) out.cards = D.nbr;                                     // lite file: the stored graph
  out.xy = layoutKnn(D.xy, k);
  for (const [name, xy] of Object.entries(extra)) out[`xy:${name}`] = layoutKnn(xy, k);
  if (rawDir) { const r = await rawSpace(D, rawDir, k); if (r) out.raw = r; }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────
// Guarded so `scoreSpace` above can be imported and unit-tested (test/eval-relatedness.test.ts) without
// the CLI running.
if (import.meta.main) {
const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name: string) => argv.includes(`--${name}`);
const k = parseInt(flag("k", "10")!, 10), pairs = parseInt(flag("pairs", "200000")!, 10);
const layouts: Record<string, number[][]> = {};
argv.forEach((a, i) => { if (a === "--layout") { const [name, path] = argv[i + 1].split("="); layouts[name] = JSON.parse(readFileSync(path, "utf8")); } });
const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && ["k", "pairs", "layout", "json", "raw"].includes(argv[i - 1].slice(2))));
// default target set: the shipped corpora, under this checkout's out/ — or, when running from a git
// worktree (where out/ is gitignored and lives only in the main checkout), the main checkout's out/.
const OUTS = [join(REPO, "out"), join(REPO, "..", "..", "..", "out")];
const DEFAULTS = ["pitchfork", "simple-wikipedia-400", "openrouter-model-cards", "open-library-300", "aesop-fables", "graham-essays"]
  .flatMap((s) => OUTS.map((o) => join(o, s, `${s}.eido`))).filter(existsSync);
const targets = files.length ? files : DEFAULTS.length ? DEFAULTS : [];
if (!targets.length) { console.error("no .eido given and no out/<slug>/<slug>.eido found — pass paths explicitly"); process.exit(1); }

mkdirSync(VDIR, { recursive: true });
const cells: Cell[] = [];
const notes: string[] = [];
for (const f of targets) {
  CORPUS_KEY = basename(f).replace(/\.eido$/, "");
  const D = decodeMap(new Uint8Array(readFileSync(f)));
  const vs = REGISTRY[CORPUS_KEY];
  if (!vs) { notes.push(`${CORPUS_KEY}: no verifier registered — skipped (add one to REGISTRY in bin/eval-relatedness.ts)`); continue; }
  if (!vs.length) { notes.push(`${CORPUS_KEY}: NO external verifier exists for this corpus (${D.ids.length} docs) — it is unmeasured, not passing`); continue; }

  // resolve each verifier to a label set (fetching sidecars only under --fetch)
  const resolved: { v: Verifier; L: LabelSet }[] = [];
  for (const v of vs) {
    if (v.read) { resolved.push({ v, L: v.read(D) }); continue; }
    const path = join(VDIR, `${CORPUS_KEY}.${v.key}.json`);
    if (has("fetch") || !existsSync(path)) {
      if (!has("fetch")) { notes.push(`${CORPUS_KEY}/${v.key}: sidecar missing (${path}) — run with --fetch`); continue; }
      console.error(`fetching ${CORPUS_KEY}/${v.key}…`);
      writeFileSync(path, JSON.stringify(await v.fetch!(D)));
    }
    const raw: Record<string, string[] | number> = JSON.parse(readFileSync(path, "utf8"));
    const vals = D.ids.map((id) => raw[id]);
    resolved.push({ v, L: v.kind === "num" ? { kind: "num", vals: vals as (number | undefined)[] } : { kind: "cat", vals: vals as (string[] | undefined)[] } });
  }
  if (!resolved.length) continue;

  const spaces = await spacesOf(D, k, layouts, flag("raw"));
  for (const [space, nbr] of Object.entries(spaces))
    for (const { v, L } of resolved) {
      const c = scoreSpace(CORPUS_KEY, space, nbr, L, k, pairs);
      if (c) cells.push({ ...c, verifier: v.key });
      else notes.push(`${CORPUS_KEY}/${v.key}: fewer than 10 labelled documents — not scored`);
    }
}

// ── report: one row per corpus × verifier × space. No totals, by design. ─────────────────────────────
const pad = (s: string, w: number) => s.padEnd(w);
const rows = cells.map((c) => [c.corpus, c.verifier, c.space, String(c.k), String(c.n), (c.coverage * 100).toFixed(0) + "%", c.metric,
  c.score.toFixed(4), c.base.toFixed(4), c.lift >= 100 ? c.lift.toFixed(0) + "×" : c.lift.toFixed(2) + "×"]);
const head = ["corpus", "verifier", "space", "k", "n", "cov", "metric", "observed", "baseline", "lift"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
console.log(head.map((h, i) => pad(h, w[i])).join("  "));
console.log(w.map((x) => "-".repeat(x)).join("  "));
for (const r of rows) console.log(r.map((x, i) => pad(x, w[i])).join("  "));
if (notes.length) { console.log("\nnotes:"); for (const n of notes) console.log("  · " + n); }
const out = flag("json");
if (out) writeFileSync(out, JSON.stringify({ k, pairs, generated: Date.now(), cells, notes }, null, 2));
}
