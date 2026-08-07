// The synthetic corpus both e2e suites use. Shared so neither depends on a gitignored fixture that
// only exists after a real pipeline run — that dependency is why CI could not run the full gate.
import type { MapContract } from "../src/schema.ts";

export function synthMap(): MapContract {
  const B = 3, PER = 30, N = B * PER;
  const axes = [
    { key: "a", name: "AxisA", low: "LowA", high: "HighA", variance: 0.4 },
    { key: "b", name: "AxisB", low: "LowB", high: "HighB", variance: 0.2 },
  ];
  const centers = [[0, 0], [1.6, 1.1], [-1.6, -1.1]];
  const ids: string[] = [], titles: string[] = [], cores: string[] = [], xy: number[][] = [], xyz: number[][] = [];
  const L0: number[] = [], L1: number[] = [], L2: number[] = [], L3: number[] = [], hub: number[] = [], nbr: number[][] = [];
  const sa: number[] = [], sb: number[] = [], read: (boolean | undefined)[] = [];
  for (let b = 0; b < B; b++) for (let i0 = 0; i0 < PER; i0++) {
    const k = b * PER + i0;
    const jx = (((i0 * 37) % 11) / 11 - 0.5) * 0.5, jy = (((i0 * 53) % 11) / 11 - 0.5) * 0.5;
    ids.push("d" + k); titles.push(`Doc ${b}.${i0}`); cores.push(`blob${b} item ${i0} ${["alpha", "beta", "gamma"][b]}`);
    xy.push(k === 0 ? [0, 0] : [centers[b][0] + jx, centers[b][1] + jy]);
    // The 3D cloud is deliberately NOT flat, and blob 0 is a COLUMN along the depth axis through the
    // camera target. Diving into an orbit camera then puts blob 0's near half BEHIND the eye while it is
    // still dead-centre on screen — which is exactly the case the lasso's NDC-z guard exists to reject.
    xyz.push([centers[b][0], centers[b][1], b === 0 ? (i0 / PER - 0.5) * 9 : (b - 1) * 2.5]);
    L0.push(b); L1.push(b * 2 + (i0 < 15 ? 0 : 1));
    L2.push(b * 4 + Math.min(3, Math.floor(i0 / 7.5)));
    L3.push(b * 8 + Math.min(7, Math.floor(i0 / 3.75)));
    hub.push(1 + (i0 % 5)); nbr.push([b * PER + ((i0 + 1) % PER), b * PER + ((i0 + 2) % PER)]);
    sa.push(Math.round((i0 / PER) * 100)); sb.push(Math.round(((PER - i0) / PER) * 100));
    read.push(k % 3 === 0 ? true : false);
  }
  const levels = [L0, L1, L2, L3], counts = [3, 6, 12, 24];
  const levelLabels = counts.map((n, i) => Array.from({ length: n }, (_, c) => `L${i}R${c}`));
  const cluster = L2, k = 12; // default level (di=2)
  const clusters = Array.from({ length: k }, (_, c) => ({ c, n: cluster.filter((x) => x === c).length, label: "L2R" + c, cx: 0, cy: 0 }));
  const cite: number[][] = ids.map(() => []); cite[0] = [1, 2, 31]; cite[3] = [4]; cite[31] = [0];
  const ghosts = [{ title: "GhostPaper Attention", arxiv: "2101.00001", url: "https://arxiv.org/abs/2101.00001", n: 5, core: "a cited-but-absent paper", xy: [0.8, 0.5] as [number, number], sim: 0.6 }];
  return {
    version: 1, ids, titles, cores, notes: ids.map(() => ({ a: "note on a", b: "note on b" })), axes,
    scores: { a: sa, b: sb }, xy, xyz, cluster, k, di: 2, hub, nbr, clusters, levels, counts, levelLabels,
    levelBlurbs: counts.map((n) => Array.from({ length: n }, () => "blurb")),
    cite, citec: hub.map((h) => h * 2), ghosts, read,
    // the LAST card is deliberately bare (no author/date/url/source) to prove the detail panel degrades gracefully (eid-m107)
    urls: ids.map((_, i) => (i === N - 1 ? undefined : `https://read.example/${i}`)),
    sources: ids.map((_, i) => (i === N - 1 ? undefined : i % 2 ? `https://src.example/${i}` : undefined)),
    siteNames: ids.map((_, i) => (i === N - 1 ? undefined : i % 2 ? "src.example" : undefined)),
    authors: ids.map((_, i) => (i === N - 1 ? undefined : `Author ${i % 4}`)),
    dates: ids.map((_, i) => (i === N - 1 ? undefined : 1_700_000_000_000 + i * 86_400_000)),
    // v2: carry per-node vectors (f16 on the wire) + derivedBy — proves the browser loader tolerates the
    // new optional sections (an f16 buffer in the manifest it doesn't read, and the provenance record).
    // …and the vectors carry the BLOB STRUCTURE (a one-hot blob component + per-card jitter), so a derived
    // axis over a circled blob is a real contrast the suite can assert, not noise that happens to score.
    vectors: { data: Float32Array.from(ids.flatMap((_, i) => { const b = Math.floor(i / PER); return Array.from({ length: 8 }, (_, j) => (j === b ? 1 : 0) + 0.15 * Math.sin(i * 0.7 + j)); })), dim: 8 },
    provenance: { title: "synth-corpus", source: "e2e/synth.ts", generated: 1, count: N },
    derivedBy: { cardModel: "test/model", embedder: { id: "Xenova/all-MiniLM-L6-v2", dim: 8, pooling: "mean", normalized: true }, geometryBasis: "card" as const, generated: 1 },
  };
}

// a deliberately DIFFERENT map (2 regions vs 12) so ?map= loading it is distinguishable from the default
export function altSynth(): MapContract {
  const N = 6, ids: string[] = [], titles: string[] = [], cores: string[] = [], xy: number[][] = [], xyz: number[][] = [], cluster: number[] = [], hub: number[] = [], nbr: number[][] = [], sa: number[] = [];
  for (let i = 0; i < N; i++) { const b = i < 3 ? 0 : 1; ids.push("a" + i); titles.push("Alt " + i); cores.push("alt doc " + i); xy.push([b ? 1 : -1, (i % 3) * 0.2]); xyz.push([b ? 1 : -1, 0, 0]); cluster.push(b); hub.push(1); nbr.push([(i + 1) % N]); sa.push(Math.round((i / N) * 100)); }
  return {
    version: 1, ids, titles, cores, notes: ids.map(() => ({ a: "n" })), axes: [{ key: "a", name: "AxisA", low: "Lo", high: "Hi", variance: 0.5 }],
    scores: { a: sa }, xy, xyz, cluster, k: 2, di: 0, hub, nbr,
    clusters: [{ c: 0, n: 3, label: "Alt-A" }, { c: 1, n: 3, label: "Alt-B" }],
    levels: [cluster], counts: [2], levelLabels: [["Alt-A", "Alt-B"]], levelBlurbs: [["x", "x"]],
  };
}

