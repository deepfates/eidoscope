import { ax } from "@ax-llm/ax";

// The gorm layer: three signatures, each a narrow, typed dose of fluid intelligence.
// The model may LABEL axes and SCORE documents — it never invents the axes themselves.
// (Ax requires descriptive field names, so no bare `text`/`title`/`name`.)

// Restate a document in one uniform voice and place it on the corpus's discovered axes. The result IS
// the card (its eidos) — the normalized form we embed and compare to build the map. Intent lives in the
// field descriptions (declarative); wording/format is the optimizer's job later, so no length cuffs here.
export const deriveCard = ax(`
  documentTitle:string,
  documentText:string "the full document",
  corpusAxes:string "the corpus's discovered axes, each with its low pole and high pole, in order" ->
  restatement:string "restate this document in one neutral, uniform voice — the same voice for every author, source, and format — so documents can be compared by content instead of style. Keep every distinguishing detail: named entities, quantities, specific claims, mechanisms. Remove only genuine redundancy; match the source's information density — a short, dense document stays short, never padded, and a rich one is never flattened into a vague gist. This is a normalization, not a summary.",
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

// Name a cluster / region from a sample of its most typical members.
export const nameCluster = ax(`
  memberSamples:string "titles and summaries of documents in one region" ->
  regionLabel:string "2-4 word landmark label",
  regionBlurb:string "one line describing the region"
`);
