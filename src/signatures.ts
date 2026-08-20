import { ax } from "@ax-llm/ax";
import { hash } from "./llm.ts";

// The gorm layer: three signatures, each a narrow, typed dose of fluid intelligence.
// The model may LABEL axes and SCORE documents — it never invents the axes themselves.
// (Ax requires descriptive field names, so no bare `text`/`title`/`name`.)

// Restate a document in one uniform voice AND place it on the corpus's discovered axes, in ONE call.
// Cached (see card.ts) by document content + the DETERMINISTIC axis geometry — the LLM's axis LABELS are
// cosmetic and never gate this cache, so re-running the same corpus reloads every card even when it renames.
const DERIVE_CARD_SRC = `
  documentTitle:string,
  documentText:string "the full document",
  corpusAxes:string "the corpus's discovered axes, each with its low pole and high pole, in order" ->
  restatement:string "restate this document in one neutral, uniform voice — the same voice for every author, source, and format — so documents can be compared by content instead of style. Speak about the SUBJECT, never about the document as an artifact — never open with 'This document/review/article…'. Keep every distinguishing detail: named entities, quantities, specific claims, mechanisms. Remove only genuine redundancy; match the source's information density — a short, dense document stays short, never padded, and a rich one is never flattened into a vague gist. This is a normalization, not a summary.",
  axisPlacements:string[] "one entry per axis, in the given order: in neutral language, what in this document places it where it sits on that axis relative to the rest of the corpus. Every document has a position on every axis."
`;
export const deriveCard = ax(DERIVE_CARD_SRC);

// Name a discovered statistical axis from the documents sitting at its two poles.
export const labelAxis = ax(`
  highPoleTitles:string "titles at the high end of one statistical axis",
  lowPoleTitles:string "titles at the low end of the same axis" ->
  coherenceScore:number "1-5: is this a single interpretable axis (5) or noise (1)?",
  axisName:string "short axis name",
  lowPoleLabel:string "what the low group is, <= 8 words",
  highPoleLabel:string "what the high group is, <= 8 words"
`);

// Name ALL the axes in ONE call, so the model sees the whole set and can make them DISTINCT
// instead of independently rediscovering the dominant contrast on every axis. Same discipline —
// it may only name poles it's shown, never invent axes — but with global context.
export const labelAxes = ax(`
  axesPoles:string "numbered list of orthogonal statistical axes; each shows the document titles at its HIGH pole and its LOW pole" ->
  axisNames:string[] "one short name per axis, in order — each a DISTINCT contrast; the axes are orthogonal so no two should mean the same thing; name at most one axis around 'technical vs theoretical', and for every other axis give the secondary contrast that separates it FROM the others",
  lowPoleLabels:string[] "what each axis's low group is, <= 6 words, in order",
  highPoleLabels:string[] "what each axis's high group is, <= 6 words, in order",
  coherenceScores:number[] "1-5 per axis, in order: 5=a crisp single interpretable contrast, 1=incoherent/noise"
`);

// Aggregate token usage across every signature above — Ax records per-model usage on each program as
// calls complete, so summing the four programs covers carding + axis labeling + region naming. Cached
// calls spend nothing and appear nowhere. Ax's normalized usage carries tokens only (an OpenAI-shaped
// endpoint reports no pricing), so we report tokens and never fabricate a dollar figure.
export function llmUsage(): { prompt: number; completion: number; total: number; models: string[]; reported: boolean } {
  let prompt = 0, completion = 0, total = 0, reported = false;
  const models = new Set<string>();
  for (const p of [deriveCard, labelAxes, labelAxis, nameCluster]) {
    for (const u of ((p as any).getUsage?.() ?? []) as any[]) {
      reported = true;
      if (u?.model) models.add(u.model);
      const t = u?.tokens; if (!t) continue;
      prompt += t.promptTokens ?? 0; completion += t.completionTokens ?? 0;
      total += t.totalTokens ?? (t.promptTokens ?? 0) + (t.completionTokens ?? 0);
    }
  }
  return { prompt, completion, total, models: [...models], reported };
}

// One honest line for the console + REPORT.md. Three cases, never faked: real tokens; calls made but
// the endpoint returned no counts; or zero calls (everything served from cache).
export function llmUsageLine(): string {
  const u = llmUsage();
  if (u.total > 0) return `LLM usage: ${u.prompt.toLocaleString("en-US")} prompt + ${u.completion.toLocaleString("en-US")} completion = ${u.total.toLocaleString("en-US")} tokens (${u.models.join(", ") || "model unknown"}; carding + naming — cost not shown: the endpoint reports no pricing)`;
  if (u.reported) return "LLM usage: tokens unavailable — this endpoint returned no usage counts";
  return "LLM usage: 0 tokens — every card and label came from cache";
}

// NAMING SHAPE, MEASURED 2026-08-14 (eid-mrtw) — three constraints, each kept only because a relabel
// run showed it doing something. This instruction used to say "2-4 word landmark label", and across the
// nine shipped corpora 66% of region names broke it, mostly as three-item lists ("Human Labor, Jupiter,
// and Burdened Frogs") — the "keyword salad" the ticket is named for.
//
// What each change bought, counted on real relabels rather than reasoned about:
//
//   aesop-fables            ≤4 words   fits the map (≤26 chars, deckmap dispLabel)
//     baseline                3%          4%
//     + hard word limit      88%         --
//     + ban the LIST shape   96%         72%
//
//   simple-wikipedia-400   ≤4 words   fits the map
//     baseline               31%          6%
//     + word limit + list   100%          8%     ← words fixed, reader saw NO change
//     + 26-CHARACTER BUDGET 100%        100%
//
// THE LESSON IS THE SECOND TABLE. A word cap is not the constraint the reader experiences: the renderer
// truncates CHARACTERS, and "Geographically Designated Entities" is three words and 34 characters. On a
// short-vocabulary corpus the word limit happened to help; on an encyclopedic one — exactly the case the
// ticket was filed about — it moved the reader-facing number by two points. Constraining what actually
// gets cut took that corpus from 6% to 100%, and turned "Located Within Geographic and Biological
// Processes" into "Geography and Biology".
//
// Across all eight corpora: 34% of names fit the map before, 99% after.
//
// Still true and still open on the ticket: not one region in any run came back with a SINGLE-concept
// name — every run is ~100% conjunctions, and no amount of instruction moved that. Whether a landmark
// should name one thing rather than two is a judgement about what a map label is for, and it is the part
// of this ticket that measurement cannot settle.
//
// Name a region — but PHRASE a contrast the deterministic layer already computed, don't rediscover it.
// distinctiveTerms/distinctiveAxes are what makes this region distinct from the REST of the corpus
// (globally-frequent tokens are already filtered out upstream); the members ground it in specifics.
// So the label names what SEPARATES this region, not the generic theme it shares with its neighbors.
const NAME_CLUSTER_SRC = `
  distinctiveTerms:string "terms this region over-uses relative to the rest of the corpus — the words that set it apart",
  distinctiveAxes:string "the discovered axes this region sits at an extreme on vs other regions, each with the pole it leans toward",
  memberSamples:string "titles and one-line restatements of representative documents in this region" ->
  regionLabel:string "AT MOST FOUR WORDS **AND AT MOST 26 CHARACTERS INCLUDING SPACES** — both are hard limits, not targets. Count the characters before you answer; if it is over, choose shorter words, not fewer letters. A landmark on a map, not a description of one. NEVER a list: no commas, and never three things joined. Two joined terms are allowed only when the pair itself is the distinction; if you find yourself reaching for a third, you are describing the region's contents instead of naming it — keep the one term that separates it from its neighbours and drop the rest. Build it ONLY from the distinctive terms and the member samples — every significant word must be grounded in them. Do NOT add a generic category word (a genre/format label) that the terms or members do not support, even if it seems to fit the domain. Lead with the distinctive vocabulary, not a theme many regions would share.",
  regionBlurb:string "one line: what this region is and how it differs from its neighbors"
`;
export const nameCluster = ax(NAME_CLUSTER_SRC);

// ── THE PROMPT IS PART OF THE CACHE KEY ──────────────────────────────────────────────────────────────
// Both caches keyed on their INPUTS only, behind a hand-written prefix ("card1", "name2") that whoever
// edited a prompt was supposed to remember to bump. Nobody does. So editing a signature and re-running
// returned the previous prompt's output, confidently and with no way to tell — the same failure as a
// stale build or a stale DOM, and the one that would have made today's naming measurement meaningless.
//
// Deriving the version FROM the prompt text removes the thing to remember: any edit to either template
// changes its hash and invalidates exactly the cache it should, and nothing else.
//
// One-time cost, stated: this transition orphans existing cache entries, so the next build of an
// already-carded corpus re-cards it. That is the correct behaviour arriving late, not a new expense —
// a card IS its prompt, and the old key was quietly claiming otherwise.
export const cardVer = hash(DERIVE_CARD_SRC);
export const nameVer = hash(NAME_CLUSTER_SRC);
