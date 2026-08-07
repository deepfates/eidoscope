import type { CardVectors } from "../../src/schema";

// DERIVE — an axis from EXAMPLES instead of words. Same output as a typed semantic query (a per-card
// scalar that becomes a first-class Dimension), but the direction comes from a held SELECTION:
//
//   direction = normalize( mean(unit vectors of the selected) − mean(unit vectors of everyone else) )
//   score(card) = cosine(card vector, direction)
//
// This is the classic "difference of centroids" discriminant (Rocchio / mean-difference): the part of the
// selection that is NOT shared with the rest of the corpus. Subtracting the rest is what makes it a
// CONTRAST rather than "how close to the middle of everything" — without it every corpus's derived axis
// points at the corpus mean and separates nothing.
//
// The card vectors are the ones carried in the .eido (`MapContract.vectors`), i.e. the SAME concept-
// bottleneck card embeddings the neighbour map is built on — deriving never reaches around the cards.

// The direction, or null when there isn't an honest one to compute:
//   · no vectors carried (a lite emit)  · empty selection  · the selection IS the whole corpus (no "rest")
//   · the two centroids coincide (degenerate — nothing distinguishes the set in this space)
export function deriveDirection(vectors: CardVectors | undefined, selected: number[]): Float32Array | null {
  if (!vectors?.data.length || !selected?.length) return null;
  const dim = vectors.dim, n = (vectors.data.length / dim) | 0;
  if (!dim) return null;
  const sel = new Set<number>();
  for (const i of selected) if (i >= 0 && i < n) sel.add(i);
  if (!sel.size || sel.size === n) return null;

  const V = vectors.data;
  const inM = new Float64Array(dim), outM = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let nv = 0; for (let j = 0; j < dim; j++) nv += V[base + j] * V[base + j];
    nv = Math.sqrt(nv) || 1;                       // L2-normalize each card first, so long cards don't dominate
    const t = sel.has(i) ? inM : outM;
    for (let j = 0; j < dim; j++) t[j] += V[base + j] / nv;
  }
  const a = sel.size, b = n - sel.size;
  const d = new Float32Array(dim);
  let nd = 0;
  for (let j = 0; j < dim; j++) { const x = inM[j] / a - outM[j] / b; d[j] = x; nd += x * x; }
  nd = Math.sqrt(nd);
  if (!(nd > 1e-9)) return null;
  for (let j = 0; j < dim; j++) d[j] /= nd;
  return d;
}
