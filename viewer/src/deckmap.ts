import { Deck, OrthographicView, OrbitView } from "@deck.gl/core";
import { ScatterplotLayer, LineLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import type { MapContract } from "../../src/schema";
import { col, type RGB } from "./encode";
import { easeCubicInOut } from "d3-ease";

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
  setHighlightSet: (idx: number[] | null, color: RGB | null) => void;
  setQuery: (q: string) => void;
  setScrub: (get: ((i: number) => number) | null, range: [number, number] | null) => void;  // channel-grammar scrubber
  fitToIndices: (idx: number[]) => void;
  resetView: () => void;
  destroy: () => void;
  debug: () => { zoom: number; labels: number; regions: number; grain: number; rot: number | null; rotX: number | null; target: number[] | null; span3: number };  // read-only seam for integration tests
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
  let colorVer = 0, sizeVer = 0, posVer = 0, scrubVer = 0;
  let scrubGet: ((i: number) => number) | null = null;   // the scrubbed dimension's per-node value (channel-grammar scrubber)
  let scrubRange: [number, number] | null = null;         // active [lo,hi]; null = pass everything
  const dataFilter = new DataFilterExtension({ filterSize: 1 });
  let focus: number | null = null, fSet: Set<number> | null = null;
  let highlight: number | null = null;
  let highlightSet: Set<number> | null = null;   // isolate an arbitrary set (a facet value, e.g. a folder), not just a cluster
  let highlightSetColor: RGB = [255, 255, 255];
  let queryMatch: Set<number> | null = null;
  let citeOn = init.citeOn ?? false, ghostsOn = init.ghostsOn ?? false;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;  // single-click card-open, cancelled by a double-click (drill)
  let suppressClickUntil = 0;  // wall-clock deadline set by dblclick so a trailing deck onClick can't open a card (timestamp, not a timer — Date.now() isn't throttled like setTimeout in a hidden tab)
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
  // Guard the viewport dimension: if the map mounts into a not-yet-laid-out canvas (embedded/iframe/late
  // layout), innerWidth/Height can be 0 → log2(0) = -Infinity → a non-invertible projection and a blank map
  // that never recovers. Fall back to a sane size so zoom stays finite; deck re-renders once the canvas sizes.
  const vp = Math.min(window.innerWidth || 0, window.innerHeight || 0) || 800;
  const fitZoom = Math.log2((vp * 0.92) / span);  // fill more of the canvas (eid-rc20)
  // 3D extent (the fly/orbit layout reads D.xyz) — for camera framing + world-unit point size.
  const bb3 = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const [x, y, z] of D.xyz) { if (x < bb3.minX) bb3.minX = x; if (x > bb3.maxX) bb3.maxX = x; if (y < bb3.minY) bb3.minY = y; if (y > bb3.maxY) bb3.maxY = y; if (z < bb3.minZ) bb3.minZ = z; if (z > bb3.maxZ) bb3.maxZ = z; }
  const c3 = [(bb3.minX + bb3.maxX) / 2, (bb3.minY + bb3.maxY) / 2, (bb3.minZ + bb3.maxZ) / 2];
  const span3 = Math.max(bb3.maxX - bb3.minX, bb3.maxY - bb3.minY, bb3.maxZ - bb3.minZ) || 2;
  // SPIKE (one-camera dive): ONE OrbitView for 3D. `target` is the world point at the viewport centre and
  // rotation happens AROUND it, so parking target at the cloud centroid = "examine from outside" and dollying
  // target forward along the view ray = "fly among the concepts" — same view class, same viewState, one mental
  // map. zoom stays fixed (no balloon-inflation); scroll translates target (see the wheel handler below).
  const orbitFit = Math.log2((vp * 0.6) / span3);  // 2^zoom common-px per world unit → fit span3 into ~60% of the viewport
  const home = (l: Layout): any => l === "orbit"
    ? { target: c3, zoom: orbitFit, rotationX: 22, rotationOrbit: 0, minZoom: orbitFit - 4, maxZoom: orbitFit + 8 }  // examine: anchored at the centroid, slight tilt
    : l === "axes"
      ? { target: [0, 0, 0], zoom: Math.log2(vp * 0.4), minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
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
    const hw = (len: number) => (len * charPx) / 2 + charPx * 1.0; // half-width + ~1-char gap between neighbours
    const lineH = 30;                                             // vertical clearance in px (row spacing; long region names stack otherwise)
    const fits = (d: any, into: typeof cand) => into.every((q) => Math.abs((q.p[0] - d.p[0]) * scale) > hw(q.label.length) + hw(d.label.length) || Math.abs((q.p[1] - d.p[1]) * scale) > lineH);
    // Seed with the isolated region so clicking a legend entry ALWAYS surfaces its label (landmark you asked for),
    // even if a bigger neighbour would otherwise crowd it out; then greedy-place the rest biggest-first.
    const placed: typeof cand = highlight != null ? cand.filter((d) => d.c === highlight) : [];
    for (const d of cand) if (!placed.includes(d) && fits(d, placed)) placed.push(d);
    // nudge labels whose centroid sits near a screen edge back on-screen (long region names were clipping on mobile)
    const W = typeof window !== "undefined" ? window.innerWidth : 1200, tx = viewState?.target?.[0] ?? 0;
    for (const d of placed as any[]) { const sx = W / 2 + (d.p[0] - tx) * scale, vw = (d.label.length * charPx) / 2 + 4; d.dx = sx - vw < 6 ? 6 - (sx - vw) : sx + vw > W - 6 ? (W - 6) - (sx + vw) : 0; }
    return placed;
  };
  const dimSet = () => (focus != null ? fSet : highlightSet ? highlightSet : highlight != null ? new Set(members[highlight]) : null);
  // a point dims if excluded by the active focus/highlight isolate OR by the search query
  const isDim = (index: number) => { const ds = dimSet(); if (ds && !ds.has(index)) return true; if (queryMatch && !queryMatch.has(index)) return true; return false; };

  // PROBE (eid-6vgy): first-person fly-through instead of orbit. FirstPersonView is normally geospatial;
  // this tests whether it renders our CARTESIAN xyz cloud with a bare `position` viewState (no lng/lat).
  // deck's FirstPersonController moves a hardcoded 20 world units per step (MOVEMENT_SPEED, from source) —
  // built for geospatial scenes. Our umap cloud is only ~span3 units across, so the default overshoots ~5×.
  // Calibrate the NATIVE controls to the cloud instead of scaling data or hand-rolling movement: arrow-key
  // moveSpeed ≈ span3/12 (linear, predictable), and a gentle scrollZoom.speed so a wheel tick nudges, not leaps.
  // The controller is set at the DECK level (per-view controller props are ignored when the Deck has one),
  // so it must be layout-aware and updated on every switch. In fly mode, calibrate the NATIVE controls to
  // the small cloud: arrow-key moveSpeed ≈ span3/12, gentle scrollZoom, no inertia (momentum flung the tiny
  // cloud off-screen). 2D keeps pan/pinch-zoom.
  // OrbitController: drag rotates around target, pinch zooms. We DISABLE scrollZoom and handle the wheel
  // ourselves (dolly target along the view ray — the dive) so scroll flies IN instead of scaling the scene.
  const controllerFor = (l: Layout) => l === "orbit"
    ? { doubleClickZoom: false, inertia: false, scrollZoom: false }
    : { doubleClickZoom: false, inertia: true };
  const FOVY = 50;  // OrbitView perspective; positions get the perspective/parallax, the dot itself does not
  const view = () => (layout === "orbit" ? new OrbitView({ id: "orbit", fovy: FOVY, orbitAxis: "Z" }) : new OrthographicView({ id: "ortho", flipY: false }));

  // A dot is ONE thing in every view: a pixel-radius disc sized by getRadius(), with the same min-pixel floor.
  // 2D and 3D differ only in the PROJECTION of its position (orthographic vs perspective) — never the dot. Depth
  // in 3D reads from motion parallax + occlusion as you orbit/dive, not from resizing dots (that was an ad-hoc
  // world-unit regime that made 3D dots ~4× the 2D ones — an isomorphism break). billboard keeps discs facing you.
  const pointsLayer = () => new ScatterplotLayer({
    id: "points", data: { length: n },
    getPosition: (_: any, { index }: any) => pos(index) as any,
    getFillColor: (_: any, { index }: any) => { const c = getColor(index); return (isDim(index) ? [c[0], c[1], c[2], 28] : [c[0], c[1], c[2], 255]) as any; },
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels", radiusMinPixels: 1.2, billboard: true,
    // channel-grammar scrubber: GPU range-filter on a scalar/temporal dimension (filtered-out points also go
    // non-pickable). filterSoftRange fades points near the edges instead of popping. Wide-open when no scrub.
    extensions: [dataFilter],
    getFilterValue: (_: any, { index }: any) => (scrubGet ? scrubGet(index) : 0),
    filterRange: scrubRange ?? [-1e30, 1e30],
    filterSoftRange: scrubRange ? [scrubRange[0] + (scrubRange[1] - scrubRange[0]) * 0.04, scrubRange[1] - (scrubRange[1] - scrubRange[0]) * 0.04] : undefined,
    pickable: true, autoHighlight: n < 4000, highlightColor: [255, 255, 255, 180],
    transitions: reduce ? undefined : { getPosition: { duration: 700, easing: easeCubicInOut } },
    updateTriggers: { getFillColor: colorVer, getRadius: [sizeVer, posVer], getPosition: posVer, getFilterValue: scrubVer },
  });
  const spokesLayer = () => new LineLayer({
    id: "spokes", data: focus == null ? [] : (D.nbr[focus] || []).map((j) => ({ j })),
    getSourcePosition: () => pos(focus as number) as any, getTargetPosition: (d: any) => pos(d.j) as any,
    getColor: spokeCol(), getWidth: 1,
    updateTriggers: { getSourcePosition: [posVer], getTargetPosition: [posVer], getColor: themeVer },
  });
  const hullPts = (): number[][] | null => {
    if (layout === "orbit") return null;
    const idx = highlightSet ? [...highlightSet] : highlight != null ? members[highlight] : null;
    return idx && idx.length >= 3 ? hull2d(idx.map((i) => pos(i))) : null;
  };
  const hullColor = (): RGB => (highlightSet ? highlightSetColor : col(highlight ?? 0));
  const hullLayer = () => { const h = hullPts(); return new PolygonLayer({
    id: "hull",
    data: h ? [h] : [],
    getPolygon: (d: any) => d, stroked: true, filled: true,
    getFillColor: [...hullColor(), 22] as any, getLineColor: [...hullColor(), 150] as any, getLineWidth: 1.5, lineWidthUnits: "pixels",
    updateTriggers: { data: [highlight, highlightSet, posVer], getFillColor: [highlight, highlightSet], getLineColor: [highlight, highlightSet] },
  }); };
  const labelLayer = () => new TextLayer({
    id: "labels",
    data: decluttered(),
    getPosition: (d: any) => d.p, getText: (d: any) => d.label,
    getColor: (d: any) => [...col(d.c), highlight != null && d.c !== highlight ? 40 : 240] as any, getSize: 13, sizeUnits: "pixels",  // dim other regions' labels when one is isolated
    fontFamily: "ui-monospace, monospace", fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center",
    getPixelOffset: (d: any) => [d.dx || 0, 0],  // keep edge labels on-screen
    getBackgroundColor: labelBg(), background: true, backgroundPadding: [4, 2],
    updateTriggers: { getPosition: [posVer], data: [posVer], getColor: [highlight], getPixelOffset: [posVer], getBackgroundColor: themeVer },
  });
  // 3D region labels: billboarded at each region's 3D centroid, so the fly-through stays isomorphic with the
  // 2D map (same regions, colours, names — one mental map at a different angle). No screen-space declutter in
  // 3D (positions move with the camera) — just show them all, biggest-first; deck's depth sorts them.
  const centroid3 = (idx: number[]): number[] => { let x = 0, y = 0, z = 0; for (const i of idx) { const p = D.xyz[i]; x += p[0]; y += p[1]; z += p[2]; } const k = idx.length || 1; return [x / k, y / k, z / k]; };
  const label3dLayer = () => new TextLayer({
    id: "labels",
    data: members.map((idx, c) => ({ c, label: dispLabel(labelOf(c)), n: idx.length, p: centroid3(idx) })).filter((d) => d.n > 0 && d.label).sort((a, b) => b.n - a.n),
    getPosition: (d: any) => d.p, getText: (d: any) => d.label,
    getColor: (d: any) => [...col(d.c), highlight != null && d.c !== highlight ? 70 : 245] as any, getSize: 14, sizeUnits: "pixels", sizeMaxPixels: 22, billboard: true,
    fontFamily: "ui-monospace, monospace", fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center", characterSet: "auto",
    getBackgroundColor: labelBg(), background: true, backgroundPadding: [4, 2],
    updateTriggers: { getPosition: [posVer, grain], data: [posVer, grain], getColor: [highlight], getBackgroundColor: themeVer },
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
    ...(highlight != null || highlightSet ? [hullLayer()] : []),
    ...(citeOn && D.cite ? [citeLayer()] : []),
    ...(focus != null ? [spokesLayer()] : []),
    pointsLayer(),
    ...(ghostsOn && D.ghosts ? [ghostLayer()] : []),
    ...(showLabels ? [layout === "orbit" ? label3dLayer() : labelLayer()] : []),
  ];

  let viewState: any = home(layout);
  // Keep the live layer array so the per-frame zoom handler can refresh ONLY the label layer (reveal-on-zoom)
  // instead of rebuilding the whole stack (incl. the 13k-pt cloud) every wheel tick — that was ~5fps at 13k
  // (measured, e2e/perf.ts). Reusing the other layer INSTANCES lets deck diff them as unchanged (no re-upload).
  let cur: any[] = layers();
  const paint = () => { cur = layers(); deck.setProps({ layers: cur }); };                                   // full rebuild (color/focus/layout change) — keeps `cur` fresh
  const paintLabels = () => { cur = cur.map((l: any) => (l && l.id === "labels" ? labelLayer() : l)); deck.setProps({ layers: cur }); };
  const deck = new Deck({
    canvas, views: [view()], viewState,
    controller: controllerFor(layout), pickingRadius: 8,
    onViewStateChange: ({ viewState: vs }: any) => {
      const zoomed = Math.abs((vs?.zoom ?? 0) - (viewState?.zoom ?? 0)) > 0.08;
      viewState = vs; deck.setProps({ viewState });
      if (zoomed && showLabels) paintLabels();  // reveal/hide labels as zoom changes — label layer only, not the cloud
    },
    layers: cur,
    onClick: (info: any) => {
      if (Date.now() < suppressClickUntil) return;  // ignore the click deck fires right after a double-click
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
    paint();
    fit(members[levels[newGrain][nodeIdx]] || []);
    init.onGrainChange?.(newGrain);
  };
  canvas.addEventListener("dblclick", (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }  // a double-click drills; cancel the pending card-open
    suppressClickUntil = Date.now() + 350;  // …and swallow the trailing onClick deck fires right after this
    const info = (deck as any).pickObject({ x: (e as MouseEvent).offsetX, y: (e as MouseEvent).offsetY, radius: 8 });
    if (info && info.layer?.id === "points" && info.index >= 0) drill(info.index);
  });
  // SPIKE — the dive: in 3D, the wheel dollies `target` along the view ray instead of zooming. We get the ray
  // direction from the viewport's own unproject (near→far through screen centre), so it's exact in world space
  // regardless of orbitAxis/rotation. Moving target translates the whole rig forward (camera = target + fixed
  // offset), so dots get CLOSER as you enter the cloud without changing screen size (no balloon). Target is
  // clamped to the cloud's bounds + a margin, so you physically cannot fly off into the void — the anchor that
  // orbit had, kept while flying. Wheel-down = forward (into the cloud); wheel-up = back out to examine.
  canvas.addEventListener("wheel", (e) => {
    if (layout !== "orbit") return;
    const w = e as WheelEvent; w.preventDefault();
    const vp: any = deck.getViewports?.()?.[0]; if (!vp) return;
    const t = viewState.target as number[];
    // Dive toward the CURSOR (unproject the mouse ray near→far), so you go where you're looking, not just to
    // screen centre. The ray is exact world-space regardless of orbitAxis/rotation.
    const ox = w.offsetX ?? vp.width / 2, oy = w.offsetY ?? vp.height / 2;
    const p0 = vp.unproject([ox, oy, 0]);
    const p1 = vp.unproject([ox, oy, 1]);
    let fx = p1[0] - p0[0], fy = p1[1] - p0[1], fz = p1[2] - p0[2];
    const len = Math.hypot(fx, fy, fz) || 1; fx /= len; fy /= len; fz /= len;
    // Magnitude-scaled: a normal wheel notch (~100 deltaY) crosses a meaningful slice of the cloud, so ~4–5
    // notches take you from examine to inside. deltaY is clamped so a flung trackpad can't teleport.
    const dy = Math.max(-120, Math.min(120, w.deltaY || 0));
    const step = span3 * 0.0026 * dy;  // wheel-down (deltaY>0) = dive forward; ~5 notches cross into the cloud
    const m = span3 * 0.5;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo - m, Math.min(hi + m, v));
    viewState = { ...viewState, target: [
      clamp(t[0] + fx * step, bb3.minX, bb3.maxX),
      clamp(t[1] + fy * step, bb3.minY, bb3.maxY),
      clamp(t[2] + fz * step, bb3.minZ, bb3.maxZ),
    ] };
    deck.setProps({ viewState });  // 3D labels are billboarded → they re-render with the camera automatically
  }, { passive: false });

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
      if (layout !== prev) {
        posVer++;
        // Never reset the camera on a layout switch — that snapped the zoom before the points eased (the
        // jarring pre-jump). mde<->axes share the OrthographicView, so we change nothing but posVer and let
        // the positions ease. ortho<->orbit changes the VIEW TYPE, but `zoom` means the same in both
        // (2^zoom px per world unit), so KEEP the current target+zoom and only swap the view + add/drop the
        // orbit rotation. The points still ease from the flat plane (z=0) up into xyz — that's the 3D reveal.
        const viewChanged = (layout === "orbit") !== (prev === "orbit");
        if (viewChanged) { viewState = home(layout); deck.setProps({ views: [view()], viewState, controller: controllerFor(layout) }); }  // ortho<->fly: view + controller differ, reset to the new view's home
      }
      paint();
    },
    setFocus: (i) => { focus = i; fSet = i == null ? null : new Set<number>([i, ...(D.nbr[i] || [])]); colorVer++; paint(); },
    setHighlight: (c) => { highlight = c; highlightSet = null; colorVer++; paint(); },
    setHighlightSet: (idx, color) => { highlightSet = idx && idx.length ? new Set(idx) : null; if (color) highlightSetColor = color; highlight = null; colorVer++; paint(); },
    setQuery: (q) => {
      const s = q.trim().toLowerCase();
      queryMatch = !s ? null : new Set<number>(D.ids.map((_, i) => i).filter((i) => D.titles[i].toLowerCase().includes(s) || D.cores[i].toLowerCase().includes(s)));
      colorVer++; paint();
    },
    fitToIndices: (idx) => fit(idx),
    debug: () => ({ zoom: (deck.getViewports?.()?.[0] as any)?.zoom ?? viewState?.zoom ?? 0, labels: decluttered().length, regions: members.filter((m) => m.length).length, grain, rot: viewState?.rotationOrbit ?? null, rotX: viewState?.rotationX ?? null, target: viewState?.target ?? null, span3 }),
    project: (worldXY) => { const vp = (deck as any).getViewports?.()[0]; return vp ? vp.project([worldXY[0], worldXY[1], 0]).slice(0, 2) : [0, 0]; },
    pickAt: (x, y) => { const o = (deck as any).pickObject?.({ x, y, radius: 8 }); return o ? { layer: o.layer?.id ?? null, url: o.object?.url ?? null, index: o.index ?? -1 } : null; },
    resetView: () => { viewState = home(layout); deck.setProps({ viewState }); },
    setScrub: (get, range) => { scrubGet = get; scrubRange = range; scrubVer++; paint(); },
    destroy: () => deck.finalize(),
  };
}
