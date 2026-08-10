// Browser-side probe for e2e/knn.e2e.ts — bundled with `bun build --target=browser` and executed in
// real Chromium. Two receipts, both against exact truth computed RIGHT HERE in the page:
//   (1) the page kNN seam picks exact-gpu above HNSW_MIN and its neighbors ARE the exact answer;
//       the vendored hnswlib wasm clears 0.99 recall at eidoscope params.
//   (2) an end-to-end in-page ENGINE run (real buildMap, mock LLM signatures, deterministic embedder,
//       n past HNSW_MIN) emits nbr lists that match exact truth — the honest-neighbors receipt for
//       what a browser-built map actually carries.
import { buildMap } from "../src/engine";
import { knnExact, poolEmbedWith, HNSW_MIN } from "../src/geometry";
import { pageKnn } from "../viewer/src/knn";
import { hnswWasmKnn } from "../vendor/hnswlib-wasm/hnsw";
import { SEED } from "../src/axes";
import type { Doc } from "../src/corpus-core";

const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const clustered = (n: number, d: number, seed = 7) => {
  const rnd = mulberry(seed);
  const centers = Array.from({ length: 8 }, () => Array.from({ length: d }, () => (rnd() - 0.5) * 2));
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % 8], v = c.map((x) => x + (rnd() + rnd() + rnd() - 1.5) * 0.6);
    const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / s);
  });
};
const dot = (a: number[], b: number[]) => { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; };
const unit = (v: number[]) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
// exact-up-to-f32-ties row check: every reported neighbor is a true member or tied with the K-th
const exactUpToTies = (X: number[][], got: number[][], truth: number[][], K: number) => {
  let bad = 0;
  for (let i = 0; i < got.length; i++) {
    const t = new Set(truth[i].slice(1));
    const kth = dot(X[i], X[truth[i][Math.min(K, truth[i].length - 1)]]);
    for (const j of got[i].slice(1)) if (!t.has(j) && Math.abs(dot(X[i], X[j]) - kth) >= 1e-5) bad++;
  }
  return bad;
};
const recall = (got: number[][], truth: number[][]) => {
  let hit = 0, tot = 0;
  for (let i = 0; i < got.length; i++) { const t = new Set(truth[i].slice(1)); for (const j of got[i].slice(1)) { tot++; if (t.has(j)) hit++; } }
  return hit / tot;
};

(window as any).runKnnProbe = async () => {
  const out: any = { gpuSupported: !!navigator.gpu };

  // ── (1) the seam at n > HNSW_MIN, d=64 (small dim so in-page exact truth stays affordable) ────────
  const n = 6000, K = 14;
  const X = clustered(n, 64);
  let t0 = performance.now();
  const seam = await pageKnn(X, K);
  out.seamMs = Math.round(performance.now() - t0);
  out.seamMethod = seam.method;
  t0 = performance.now();
  const truth = await knnExact(X, K);
  out.exactCpuMs = Math.round(performance.now() - t0);
  out.seamBadRows = exactUpToTies(X, seam.idx, truth.idx, K);
  out.seamRecall = +recall(seam.idx, truth.idx).toFixed(4);
  t0 = performance.now();
  const wasm = await hnswWasmKnn(X, K, SEED);
  out.wasmMs = Math.round(performance.now() - t0);
  out.wasmRecall = +recall(wasm.idx, truth.idx).toFixed(4);

  // ── (2) end-to-end engine run past HNSW_MIN: emitted nbr ≡ exact truth over the card vectors ─────
  const nDocs = HNSW_MIN + 200;
  const docs: Doc[] = Array.from({ length: nDocs }, (_, i) => ({
    id: "doc" + i, title: "Doc " + i, body: `synthetic body ${i} topic ${i % 8}`, path: "synthetic/doc" + i + ".md",
  } as Doc));
  const emb64 = clustered(nDocs, 64, 11);
  const embOf = new Map<string, number[]>();  // per-card deterministic vector keyed off the title inside the card text
  docs.forEach((d, i) => embOf.set(d.title, emb64[i]));
  const cardSig = { forward: async (_llm: any, inp: any) => ({
    restatement: "MOCKCORE " + inp.documentTitle,
    axisPlacements: (inp.corpusAxes as string).split("\n").map((_l: string, j: number) => `placement ${j + 1} of ${inp.documentTitle}`),
  }) };
  const regionSig = { forward: async (_llm: any, inp: any) => ({ regionLabel: "R:" + (inp.distinctiveTerms as string).split(",")[0].trim(), regionBlurb: "b" }) };
  const embedCardTexts = async (texts: string[]) => texts.map((t) => { const m = t.match(/Doc \d+/); return embOf.get(m ? m[0] : "")!; });
  const fullEmbeddings = await poolEmbedWith(docs.map((d) => d.title + ". " + d.body), async (items) => items.map((it) => { const m = it.text.match(/Doc \d+/); return embOf.get(m ? m[0] : "") ?? emb64[0]; }));
  t0 = performance.now();
  const { D, embs } = await buildMap(docs, fullEmbeddings, {
    llm: {}, cardSig, regionSig, embedCardTexts, concurrency: 64, name: "knn-e2e", knn: pageKnn,
  });
  out.engineMs = Math.round(performance.now() - t0);
  out.neighborsProvenance = D.derivedBy?.neighbors;
  const Xc = embs.map(unit);
  const truthC = await knnExact(Xc, 8);
  out.engineNbrBadRows = exactUpToTies(Xc, D.nbr.map((r, i) => [i, ...r]), truthC.idx, 8);
  out.engineNbrRecall = +recall(D.nbr.map((r, i) => [i, ...r]), truthC.idx).toFixed(4);
  return out;
};
(window as any).__ready = true;
