import { kmeans } from "ml-kmeans";

// Deterministic clustering, replacing curare's clusterEmbeddings/findOptimalK with the same lib
// (ml-kmeans) used directly. Seeded kmeans++ so runs reproduce; elbow method picks k.

const SEED = 42;

export function clusterEmbeddings(X: number[][], k: number): { clusters: number[] } {
  return { clusters: kmeans(X, k, { seed: SEED, initialization: "kmeans++" }).clusters };
}

const sqdist = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; };
function inertia(X: number[][], k: number): number {
  const r = kmeans(X, k, { seed: SEED, initialization: "kmeans++" });
  let s = 0; for (let i = 0; i < X.length; i++) s += sqdist(X[i], r.centroids[r.clusters[i]]);
  return s;
}

// Elbow — matched to curare's exact method (gold): sweep k in [2, kMax], WCSS per k, pick the k
// with max VERTICAL distance from the chord joining the curve's endpoints. Same seed → same k.
export function findOptimalK(X: number[][], kMax?: number): number {
  const n = X.length;
  if (n < 3) return Math.min(n, 2);
  const minK = 2, maxK = Math.min(kMax ?? Math.min(Math.max(3, Math.round(Math.cbrt(n))), 50), n - 1);
  if (maxK <= minK) return minK;
  const w: number[] = [];
  for (let k = minK; k <= maxK; k++) w.push(inertia(X, k));
  const num = w.length, first = w[0], last = w[num - 1];
  let bestK = minK, maxDist = 0;
  for (let i = 0; i < num; i++) {
    const lineY = first + (last - first) * (i / (num - 1));
    const d = Math.abs(w[i] - lineY);
    if (d > maxDist) { maxDist = d; bestK = minK + i; }
  }
  return bestK;
}
