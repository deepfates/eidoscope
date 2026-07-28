import { ax } from "@ax-llm/ax";

// The gorm layer: three signatures, each a narrow, typed dose of fluid intelligence.
// The model may LABEL axes and SCORE documents — it never invents the axes themselves.
// (Ax requires descriptive field names, so no bare `text`/`title`/`name`.)

// Place a document on the corpus's discovered axes. The result IS the card (its eidos).
export const deriveCard = ax(`
  documentTitle:string,
  documentBody:string "the document body or abstract",
  corpusAxes:string "numbered list of the corpus axes, each with its low and high pole" ->
  coreSummary:string "2-3 dense sentences: what this document is, argues, and contributes",
  axisScores:number[] "one 0-100 score per axis, in the given order; 0 = low pole, 100 = high pole",
  axisNotes:string[] "one short document-specific note per axis, in the given order"
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

// Name a cluster / region from a sample of its most typical members.
export const nameCluster = ax(`
  memberSamples:string "titles and summaries of documents in one region" ->
  regionLabel:string "2-4 word landmark label",
  regionBlurb:string "one line describing the region"
`);
