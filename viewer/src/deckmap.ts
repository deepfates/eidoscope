import { Deck, OrthographicView, OrbitView } from "@deck.gl/core";
import { ScatterplotLayer, LineLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import type { MapContract } from "../../src/schema";
import { col, type RGB } from "./encode";

// The map's rendering + interaction core. ONE Deck for its whole life (canvas pointer capture never lost);
// layout switches swap the view + camera via setProps. deck.gl gives GPU rendering, a controller with
// pan/pinch-zoom/inertia (2D) or drag-rotate (3D OrbitView), and finger-sized picking. Composed layers:
// points (encoded colour/size) · region hulls (PolygonLayer, on highlight) · region labels (TextLayer,
// collision-decluttered) · neighbour spokes (LineLayer, on focus). Everything drives through update().

export type Layout = "mde" | "axes" | "orbit";
export type MapHandle = {
  update: (o: Partial<Opts>) => void;
  setFocus: (i: number | null) => void;
  setHighlight: (c: number | null) => void;
  setQuery: (q: string) => void;
  fitToIndices: (idx: number[]) => void;
  resetView: () => void;
  destroy: () => void;
  debug: () => { zoom: number; labels: number; regions: number; grain: number };  // read-only seam for integration tests
  project: (worldXY: number[]) => number[];  // world → screen px, so tests can click exact nodes/ghosts
  pickAt: (x: number, y: number) => { layer: string | null; url: string | null; index: number } | null;  // what deck picks at a screen px
};
type Opts = { getColor: (i: number) => RGB; getRadius: (i: number) => number; layout: Layout; xKey: string; yKey: string; showLabels: boolean; grain: number; citeOn?: boolean; ghostsOn?: boolean; theme?: "dark" | "light" };

const hull2d = (pts: number[][]): number[][] => {
  if (pts.length < 3) return pts;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up: number[][] = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
};

export type HoverPayload = { kind: "point"; i: number } | { kind: "ghost"; g: any };
export function createMap(canvas: HTMLCanvasElement, D: MapContract, init: Opts & { onClick?: (i: number) => void; onHover?: (h: HoverPayload | null, x: number, y: number) => void; onGrainChange?: (g: number) => void }): MapHandle {
  const n = D.ids.length;
  const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;  // a11y: no motion
  let { getColor, getRadius, layout, xKey, yKey, showLabels, grain } = init;
  let colorVer = 0, sizeVer = 0, posVer = 0;
  let focus: number | null = null, fSet: Set<number> | null = null;
  let highlight: number | null = null;
  let queryMatch: Set<number> | null = null;
  let citeOn = init.citeOn ?? false, ghostsOn = init.ghostsOn ?? false;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;  // single-click card-open, cancelled by a double-click (drill)
  let theme: "dark" | "light" = init.theme ?? "dark", themeVer = 0;
  const dark = () => theme !== "light";
  // theme-aware map ink: on a light ground, white spokes/ghost strokes and the dark label pill invert.
  const spokeCol = () => (dark() ? [255, 255, 255, 110] : [38, 38, 52, 130]) as [number, number, number, number];
  const labelBg = () => (dark() ? [10, 12, 18, 180] : [255, 255, 255, 214]) as [number, number, number, number];
  const ghostCol = () => (dark() ? [200, 210, 225, 190] : [82, 92, 112, 205]) as [number, number, number, number];

  // per-region (at the CURRENT grain level) member indices + label — for hulls, labels, dimming, drill.
  // Recomputed whenever the grain slider moves. Falls back to the default cluster if no ladder is present.
  let members: number[][] = [];
  let labelOf: (c: number) => string = () => "";
  const recomputeGrain = () => {
    const assign = D.levels?.[grain] ?? D.cluster;
    const k = D.counts?.[grain] ?? D.k;
    members = Array.from({ length: k }, () => []);
    assign.forEach((c, i) => { if (c >= 0 && c < k) members[c].push(i); });
    const labels = D.levelLabels?.[grain];
    labelOf = (c: number) => labels?.[c] ?? D.clusters[c]?.label ?? "";
  };
  recomputeGrain();

  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of D.xy) { if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x; if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y; }
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) || 2;
  const fitZoom = Math.log2((Math.min(window.innerWidth, window.innerHeight) * 0.85) / span);
  const home = (l: Layout): any => l === "orbit"
    ? { target: [0, 0, 0], zoom: fitZoom - 0.5, rotationOrbit: 20, rotationX: 25, minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
    : l === "axes"
      ? { target: [0, 0, 0], zoom: Math.log2(Math.min(window.innerWidth, window.innerHeight) * 0.4), minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
      : { target: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, 0], zoom: fitZoom, minZoom: fitZoom - 2, maxZoom: fitZoom + 9 };

  const pos = (index: number): number[] => {
    if (layout === "axes") return [((D.scores[xKey]?.[index] ?? 50) - 50) / 50, ((D.scores[yKey]?.[index] ?? 50) - 50) / 50];
    if (layout === "orbit") return [D.xyz[index][0], D.xyz[index][1], D.xyz[index][2]];
    return [D.xy[index][0], D.xy[index][1]];
  };
  const centroid = (idx: number[]): [number, number] => { let x = 0, y = 0; for (const i of idx) { const p = pos(i); x += p[0]; y += p[1]; } return [x / (idx.length || 1), y / (idx.length || 1)]; };
  // greedy declutter: biggest regions first, skip any whose centroid is too close to one already placed
  // (world-space — deck's CollisionFilterExtension culled everything). Recomputed per layout via posVer.
  // Greedy world-space declutter, WIDTH-AWARE: model each label as an axis-aligned box whose width grows
  // with its character count (the old circle-distance test ignored text width, so long region names at
  // fine grain overlapped and clipped off-screen). On-map labels are truncated so a wide name near the
  // edge can't run past the viewport — the full name lives in the legend + detail panel.
  const dispLabel = (s: string) => (s.length > 26 ? s.slice(0, 25) + "…" : s);
  // Zoom-aware greedy declutter, in PIXEL space: biggest regions first, keep a label only if its pixel box
  // clears every already-placed one. The overlap test uses the CURRENT zoom (pixels = world · 2^zoom), so
  // zooming into a dense area spreads centroids apart and progressively reveals finer labels — the map-like
  // behavior the grain slider implies. The old test was world-space at a single fixed scale, so zooming
  // revealed nothing and fine grain dropped most labels even when the screen had room.
  const decluttered = () => {
    const scale = Math.pow(2, viewState?.zoom ?? 0);          // deck ortho: pixels per world unit at this zoom
    const cand = members.map((idx, c) => ({ c, label: dispLabel(labelOf(c)), n: idx.length, p: centroid(idx) })).filter((d) => d.n > 0 && d.label).sort((a, b) => b.n - a.n);
    const charPx = 8;                                             // ~monospace advance at 13px bold
    const hw = (len: number) => (len * charPx) / 2 + charPx * 1.5; // half-width + ~1.5-char gap between neighbours
    const lineH = 30;                                             // vertical clearance in px (row spacing; long region names stack otherwise)
    const placed: typeof cand = [];
    for (const d of cand) if (placed.every((q) => Math.abs((q.p[0] - d.p[0]) * scale) > hw(q.label.length) + hw(d.label.length) || Math.abs((q.p[1] - d.p[1]) * scale) > lineH)) placed.push(d);
    return placed;
  };
  const dimSet = () => (focus != null ? fSet : highlight != null ? new Set(members[highlight]) : null);
  // a point dims if excluded by the active focus/highlight isolate OR by the search query
  const isDim = (index: number) => { const ds = dimSet(); if (ds && !ds.has(index)) return true; if (queryMatch && !queryMatch.has(index)) return true; return false; };

  const view = () => (layout === "orbit" ? new OrbitView({ id: "orbit", orbitAxis: "Y", fovy: 50 }) : new OrthographicView({ id: "ortho", flipY: false }));

  const pointsLayer = () => new ScatterplotLayer({
    id: "points", data: { length: n },
    getPosition: (_: any, { index }: any) => pos(index) as any,
    getFillColor: (_: any, { index }: any) => { const c = getColor(index); return (isDim(index) ? [c[0], c[1], c[2], 28] : [c[0], c[1], c[2], 255]) as any; },
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels", radiusMinPixels: 1.2, billboard: true,
    pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 180],
    transitions: reduce ? undefined : { getPosition: { duration: 700 } },
    updateTriggers: { getFillColor: colorVer, getRadius: sizeVer, getPosition: posVer },
  });
  const spokesLayer = () => new LineLayer({
    id: "spokes", data: focus == null ? [] : (D.nbr[focus] || []).map((j) => ({ j })),
    getSourcePosition: () => pos(focus as number) as any, getTargetPosition: (d: any) => pos(d.j) as any,
    getColor: spokeCol(), getWidth: 1,
    updateTriggers: { getSourcePosition: [posVer], getTargetPosition: [posVer], getColor: themeVer },
  });
  const hullLayer = () => new PolygonLayer({
    id: "hull",
    data: highlight == null || layout === "orbit" ? [] : [hull2d(members[highlight].map((i) => pos(i)))],
    getPolygon: (d: any) => d, stroked: true, filled: true,
    getFillColor: [...col(highlight ?? 0), 22] as any, getLineColor: [...col(highlight ?? 0), 150] as any, getLineWidth: 1.5, lineWidthUnits: "pixels",
    updateTriggers: { data: [highlight, posVer], getFillColor: highlight, getLineColor: highlight },
  });
  const labelLayer = () => new TextLayer({
    id: "labels",
    data: decluttered(),
    getPosition: (d: any) => d.p, getText: (d: any) => d.label,
    getColor: (d: any) => [...col(d.c), 240] as any, getSize: 13, sizeUnits: "pixels",
    fontFamily: "ui-monospace, monospace", fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center",
    getBackgroundColor: labelBg(), background: true, backgroundPadding: [4, 2],
    updateTriggers: { getPosition: [posVer], data: [posVer], getBackgroundColor: themeVer },
  });
  // frontier telescope (only for --frontier arxiv corpora; absent otherwise): intra-corpus citation edges
  // + "ghost" papers cited-but-not-in-corpus, placed near the work that cites them, sized by citation count.
  const citeLayer = () => new LineLayer({
    id: "cite",
    data: (D.cite || []).flatMap((tgts, s) => tgts.map((t) => ({ s, t }))),
    getSourcePosition: (d: any) => pos(d.s) as any, getTargetPosition: (d: any) => pos(d.t) as any,
    getColor: [147, 161, 183, 40], getWidth: 0.6,
    updateTriggers: { getSourcePosition: [posVer], getTargetPosition: [posVer] },
  });
  const gmax = Math.max(1, ...(D.ghosts || []).map((g) => g.n));
  const ghostLayer = () => new ScatterplotLayer({
    id: "ghosts", data: D.ghosts || [],
    getPosition: (g: any) => g.xy as any, getRadius: (g: any) => 2 + 3 * Math.sqrt(g.n / gmax),
    radiusUnits: "pixels", radiusMinPixels: 3, stroked: true, filled: true,
    getFillColor: [0, 0, 0, 0],  // transparent fill: keeps the ring look but makes the whole disc a solid tap target
    getLineColor: ghostCol(), lineWidthUnits: "pixels", getLineWidth: 1.2,
    pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 200],
    updateTriggers: { getLineColor: themeVer },
  });
  const layers = () => [
    ...(highlight != null ? [hullLayer()] : []),
    ...(citeOn && D.cite ? [citeLayer()] : []),
    ...(focus != null ? [spokesLayer()] : []),
    pointsLayer(),
    ...(ghostsOn && D.ghosts ? [ghostLayer()] : []),
    ...(showLabels ? [labelLayer()] : []),
  ];

  let viewState: any = home(layout);
  const deck = new Deck({
    canvas, views: [view()], viewState,
    controller: { doubleClickZoom: false, inertia: true }, pickingRadius: 8,
    onViewStateChange: ({ viewState: vs }: any) => {
      const zoomed = Math.abs((vs?.zoom ?? 0) - (viewState?.zoom ?? 0)) > 0.08;
      viewState = vs; deck.setProps({ viewState });
      if (zoomed && showLabels) deck.setProps({ layers: layers() });  // reveal/hide labels as zoom changes
    },
    layers: layers(),
    onClick: (info: any) => {
      if (info?.layer?.id === "ghosts" && info.object?.url) { window.open(info.object.url, "_blank"); return; }  // ghosts open immediately
      const idx = info?.layer?.id === "points" && info.index >= 0 ? info.index : -1;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clickTimer = null; init.onClick?.(idx); }, 220);  // wait out a possible double-click (drill)
    },
    onHover: (info: any) => {
      if (!init.onHover) return;
      if (info?.layer?.id === "ghosts" && info.object) init.onHover({ kind: "ghost", g: info.object }, info.x ?? 0, info.y ?? 0);
      else if (info?.layer?.id === "points" && info.index >= 0) init.onHover({ kind: "point", i: info.index }, info.x ?? 0, info.y ?? 0);
      else init.onHover(null, info?.x ?? 0, info?.y ?? 0);
    },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });

  const fit = (idx: number[]) => {
    if (!idx.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of idx) { const p = pos(i); if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const b = Math.min(window.innerWidth, window.innerHeight), h = home(layout);
    const zoom = Math.max(h.minZoom, Math.min(h.maxZoom, Math.log2((b * 0.6) / Math.max(x1 - x0 || 0.1, y1 - y0 || 0.1))));
    viewState = { ...viewState, target: [(x0 + x1) / 2, (y0 + y1) / 2, 0], zoom, transitionDuration: reduce ? 0 : 500 };
    deck.setProps({ viewState });
  };
  // drill: step grain finer so the clicked region resolves into sub-clumps (gentle, ≤3 levels), fit to it.
  const drill = (nodeIdx: number) => {
    const levels = D.levels; if (!levels || layout === "orbit") return;
    const curRegion = (levels[grain] ?? D.cluster)[nodeIdx];
    const curMembers = members[curRegion] || [];
    let newGrain = grain;
    for (let l = grain + 1; l < levels.length && l <= grain + 3; l++) { const sub = new Set<number>(); for (const i of curMembers) sub.add(levels[l][i]); newGrain = l; if (sub.size >= 2) break; }
    if (newGrain === grain) return;
    grain = newGrain; recomputeGrain(); highlight = null; colorVer++;
    deck.setProps({ layers: layers() });
    fit(members[levels[newGrain][nodeIdx]] || []);
    init.onGrainChange?.(newGrain);
  };
  canvas.addEventListener("dblclick", (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }  // a double-click drills; cancel the pending card-open
    const info = (deck as any).pickObject({ x: (e as MouseEvent).offsetX, y: (e as MouseEvent).offsetY, radius: 8 });
    if (info && info.layer?.id === "points" && info.index >= 0) drill(info.index);
  });

  return {
    update: (o) => {
      if (o.getColor) { getColor = o.getColor; colorVer++; }
      if (o.getRadius) { getRadius = o.getRadius; sizeVer++; }
      if (o.xKey && o.xKey !== xKey) { xKey = o.xKey; posVer++; }
      if (o.yKey && o.yKey !== yKey) { yKey = o.yKey; posVer++; }
      if (o.showLabels !== undefined) showLabels = o.showLabels;
      if (o.citeOn !== undefined) citeOn = o.citeOn;
      if (o.ghostsOn !== undefined) ghostsOn = o.ghostsOn;
      if (o.theme && o.theme !== theme) { theme = o.theme; themeVer++; }
      if (o.grain !== undefined && o.grain !== grain) { grain = o.grain; recomputeGrain(); highlight = null; colorVer++; }  // grain change clears stale highlight
      const prev = layout;
      if (o.layout) layout = o.layout;
      if (layout !== prev) { posVer++; viewState = home(layout); deck.setProps({ views: [view()], viewState }); }
      deck.setProps({ layers: layers() });
    },
    setFocus: (i) => { focus = i; fSet = i == null ? null : new Set<number>([i, ...(D.nbr[i] || [])]); colorVer++; deck.setProps({ layers: layers() }); },
    setHighlight: (c) => { highlight = c; colorVer++; deck.setProps({ layers: layers() }); },
    setQuery: (q) => {
      const s = q.trim().toLowerCase();
      queryMatch = !s ? null : new Set<number>(D.ids.map((_, i) => i).filter((i) => D.titles[i].toLowerCase().includes(s) || D.cores[i].toLowerCase().includes(s)));
      colorVer++; deck.setProps({ layers: layers() });
    },
    fitToIndices: (idx) => fit(idx),
    debug: () => ({ zoom: viewState?.zoom ?? 0, labels: decluttered().length, regions: members.filter((m) => m.length).length, grain }),
    project: (worldXY) => { const vp = (deck as any).getViewports?.()[0]; return vp ? vp.project([worldXY[0], worldXY[1], 0]).slice(0, 2) : [0, 0]; },
    pickAt: (x, y) => { const o = (deck as any).pickObject?.({ x, y, radius: 8 }); return o ? { layer: o.layer?.id ?? null, url: o.object?.url ?? null, index: o.index ?? -1 } : null; },
    resetView: () => { viewState = home(layout); deck.setProps({ viewState }); },
    destroy: () => deck.finalize(),
  };
}
