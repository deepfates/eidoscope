import { ax } from "@ax-llm/ax";

// The gorm layer: three signatures, each a narrow, typed dose of fluid intelligence.
// The model may LABEL axes and SCORE documents — it never invents the axes themselves.
// (Ax requires descriptive field names, so no bare `text`/`title`/`name`.)

// Restate a document in one uniform voice AND place it on the corpus's discovered axes, in ONE call.
// Cached (see card.ts) by document content + the DETERMINISTIC axis geometry — the LLM's axis LABELS are
// cosmetic and never gate this cache, so re-running the same corpus reloads every card even when it renames.
export const deriveCard = ax(`
  documentTitle:string,
  documentText:string "the full document",
  corpusAxes:string "the corpus's discovered axes, each with its low pole and high pole, in order" ->
  restatement:string "restate this document in one neutral, uniform voice — the same voice for every author, source, and format — so documents can be compared by content instead of style. Speak about the SUBJECT, never about the document as an artifact — never open with 'This document/review/article…'. Keep every distinguishing detail: named entities, quantities, specific claims, mechanisms. Remove only genuine redundancy; match the source's information density — a short, dense document stays short, never padded, and a rich one is never flattened into a vague gist. This is a normalization, not a summary.",
  axisPlacements:string[] "one entry per axis, in the given order: in neutral language, what in this document places it where it sits on that axis relative to the rest of the corpus. Every document has a position on every axis."
`);

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

// Name a region — but PHRASE a contrast the deterministic layer already computed, don't rediscover it.
// distinctiveTerms/distinctiveAxes are what makes this region distinct from the REST of the corpus
// (globally-frequent tokens are already filtered out upstream); the members ground it in specifics.
// So the label names what SEPARATES this region, not the generic theme it shares with its neighbors.
export const nameCluster = ax(`
  distinctiveTerms:string "terms this region over-uses relative to the rest of the corpus — the words that set it apart",
  distinctiveAxes:string "the discovered axes this region sits at an extreme on vs other regions, each with the pole it leans toward",
  memberSamples:string "titles and one-line restatements of representative documents in this region" ->
  regionLabel:string "2-4 word landmark label for what makes THIS region distinct from the rest. Build it ONLY from the distinctive terms and the member samples — every significant word must be grounded in them. Do NOT add a generic category word (a genre/format label) that is not supported by the terms or members, even if it seems to fit the domain. Lead with the distinctive vocabulary, not a theme many regions would share.",
  regionBlurb:string "one line: what this region is and how it differs from its neighbors"
`);
