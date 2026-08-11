import { Deck, OrthographicView, OrbitView, LinearInterpolator } from "@deck.gl/core";
import { ScatterplotLayer, LineLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import type { MapContract } from "../../src/schema";
import { col, setActiveTheme, type RGB } from "./encode";
import { themePalette } from "./palette";
import { easeCubicInOut } from "d3-ease";
import { selectInPolygon } from "./lasso";

// The map's rendering + interaction core. ONE Deck for its whole life (canvas pointer capture never lost);
// layout switches swap the view + camera via setProps. deck.gl gives GPU rendering, a controller with
// pan/pinch-zoom/inertia (2D) or drag-rotate (3D OrbitView), and finger-sized picking. Composed layers:
// points (encoded colour/size) · region hulls (PolygonLayer, on highlight) · region labels (TextLayer,
// collision-decluttered) · neighbour spokes (LineLayer, on focus). Everything drives through update().

export type Layout = "mde" | "axes" | "orbit" | "axes3d";
// which layouts render in 3D (OrbitView): neighbour-orbit and 3-axis scatter. mde/axes are 2D (Orthographic).
const is3d = (l: Layout) => l === "orbit" || l === "axes3d";
export type MapHandle = {
  update: (o: Partial<Opts>) => void;
  setFocus: (i: number | null) => void;
  setHighlight: (c: number | null) => void;
  setFilterMask: (mask: ArrayLike<number> | null) => void;  // unified filter: 1 = passes all active filters, 0 = hidden
  fitToIndices: (idx: number[]) => void;
  resetView: () => void;
  // camera keyboard routes (M-A5): screen-px pan, zoom steps, and (3D only) orbit steps. Hold-to-repeat
  // comes free from the browser's native key repeat — each call is one small step.
  panBy: (dxPx: number, dyPx: number) => void;
  zoomBy: (d: number) => void;
  orbitBy: (dAz: number, dEl: number) => void;
  // second binding for region.drill (M-A1): drill from any member index — same code path as double-click.
  drillIndex: (i: number) => void;
  destroy: () => void;
  debug: () => { zoom: number; labels: number; regions: number; grain: number; rot: number | null; rotX: number | null; target: number[] | null; span3: number };  // read-only seam for integration tests
  project: (world: number[]) => number[];  // world [x,y,z?] → screen px, so tests can click exact nodes/ghosts
  // A card's FULL projection in the current layout: [screenX, screenY, ndcZ]. The third component is the
  // behind-camera signal the lasso guards on, so this seam lets the integration suite assert that guard
  // directly (how many cards project on-screen but sit behind the eye) rather than inferring it.
  projectIndex: (i: number) => number[] | null;
  pickAt: (x: number, y: number) => { layer: string | null; url: string | null; index: number } | null;  // what deck picks at a screen px
  // SELECT (eid-r8t6). The model OWNS the selection; deckmap only renders it and answers the one question
  // that needs the live camera: "which cards fall inside this screen path?"
  setSelection: (idx: number[] | null) => void;
  setSelectMode: (on: boolean) => void;
  selectPolygon: (path: number[][], mask: ArrayLike<number> | null) => number[];
  // CAMERA as data (eid-thbs): a saved view carries where you were standing. getCamera reads the live
  // pose; setCamera restores one — an explicit user act (`view.open`), so it is allowed to move the camera.
  getCamera: () => { target: number[]; zoom: number; rot: number | null; rotX: number | null };
  setCamera: (c: { target?: number[]; zoom?: number; rot?: number | null; rotX?: number | null }) => void;
};
type Opts = { getColor: (i: number) => RGB; getRadius: (i: number) => number; layout: Layout; getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number; posSig?: string; showLabels: boolean; grain: number; citeOn?: boolean; ghostsOn?: boolean; theme?: string };

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
  // a11y: reduced-motion means BRIEF motion, not none. Camera fits, layout eases and position morphs carry
  // object constancy — which point became which, where the camera went — and the interaction law leans on
  // them, so under the OS setting they shorten sharply (≤160ms) instead of vanishing. Measured on the iOS
  // simulator (eid-aw7x): a default phone sends no-preference; only the explicit accessibility setting
  // ("Reduce Motion" / Android "Remove animations") sends reduce. Live: toggling it mid-session takes effect.
  const rmq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
  let reduce = !!rmq?.matches;
  rmq?.addEventListener?.("change", (e) => { reduce = e.matches; });
  const dur = (ms: number) => (reduce ? Math.min(ms, 160) : ms);
  let { getColor, getRadius, layout, showLabels, grain } = init;
  // resolved position accessors from the App (dimension → -1..1 coord, with the dimension's norm/invert applied);
  // deckmap is a renderer — it does not resolve axis values itself.
  let getX = init.getX, getY = init.getY, getZ = init.getZ;
  let posSig = init.posSig ?? "";
  let colorVer = 0, sizeVer = 0, posVer = 0, filterVer = 0;
  // Unified filter: App computes one intersection mask (1 = passes ALL active filters, 0 = hidden) from the
  // shared activeFilters (facet membership + region + text + scrubber range). deck's GPU DataFilterExtension
  // culls the 0s — one path for every filter, so stacking them just ANDs into this mask.
  let filterMask: ArrayLike<number> | null = null;
  const dataFilter = new DataFilterExtension({ filterSize: 1 });
  let focus: number | null = null, fSet: Set<number> | null = null;
  // a HELD selection (frozen set of indices) + whether the lasso gesture owns the pointer right now
  let selSet: Set<number> | null = null;
  let selectMode = false;
  let highlight: number | null = null;
  let citeOn = init.citeOn ?? false, ghostsOn = init.ghostsOn ?? false;
  let suppressClickUntil = 0;  // wall-clock deadline set by dblclick so a trailing deck onClick can't open a card (timestamp, not a timer — Date.now() isn't throttled like setTimeout in a hidden tab)
  // The map's ink is read from the ACTIVE THEME's own tokens, not from a hardcoded dark/light binary:
  // ground = base-100, ink = base-content, and "dark" is simply L(base-100) < 0.5. Any theme — stock,
  // custom, one we've never seen — lands legible ink on its own canvas. Alpha levels are unchanged.
  let theme: string = init.theme || "black", themeVer = 0;
  const pal = () => themePalette(theme);
  const dark = () => pal()?.dark ?? theme !== "light";
  const ink = (): RGB => pal()?.ink ?? (dark() ? [255, 255, 255] : [38, 38, 52]);
  const ground = (): RGB => pal()?.bg ?? (dark() ? [10, 12, 18] : [255, 255, 255]);
  const spokeCol = () => [...ink(), 110] as [number, number, number, number];
  const labelBg = () => [...ground(), dark() ? 180 : 214] as [number, number, number, number];
  const ghostCol = () => [...ink(), dark() ? 190 : 205] as [number, number, number, number];
  setActiveTheme(theme);   // the palette must be live before the first getFillColor call

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
  // 3D home: an OrbitView parked at the cloud centroid, framed to fill ~60% of the viewport, with a gentle tilt
  // so it reads as 3D. deck's default OrbitController takes it from there (drag-rotate, scroll-zoom).
  const orbitFit = Math.log2((vp * 0.6) / span3);  // 2^zoom px per world unit → fit span3 into ~60% of the viewport
  const axis3Fit = Math.log2((vp * 0.6) / 2.2);    // axis coords live in ~[-1,1] (span ~2), so fit that box
  const home = (l: Layout): any =>
    l === "orbit" ? { target: c3, zoom: orbitFit, rotationX: 22, rotationOrbit: 0, minZoom: orbitFit - 4, maxZoom: orbitFit + 8 }  // examine: anchored at the centroid, slight tilt
    : l === "axes3d" ? { target: [0, 0, 0], zoom: axis3Fit, rotationX: 22, rotationOrbit: 0, minZoom: axis3Fit - 4, maxZoom: axis3Fit + 8 }  // 3-axis box centred at origin
    : l === "axes" ? { target: [0, 0, 0], zoom: Math.log2(vp * 0.4), minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
    : { target: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, 0], zoom: fitZoom, minZoom: fitZoom - 2, maxZoom: fitZoom + 9 };

  const pos = (index: number): number[] => {
    if (layout === "axes") return [getX(index), getY(index)];
    if (layout === "axes3d") return [getX(index), getY(index), getZ(index)];  // three honest axes on x/y/z
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
  // hovering a region label reveals its FULL name in place (eid-kzv2 item 3) — the label itself expands;
  // no tooltip, no extra chrome. Cleared when the pointer leaves the label.
  let hoverLabel: number | null = null;
  // Zoom-aware greedy declutter, in PIXEL space: biggest regions first, keep a label only if its pixel box
  // clears every already-placed one. The overlap test uses the CURRENT zoom (pixels = world · 2^zoom), so
  // zooming into a dense area spreads centroids apart and progressively reveals finer labels — the map-like
  // behavior the grain slider implies. The old test was world-space at a single fixed scale, so zooming
  // revealed nothing and fine grain dropped most labels even when the screen had room.
  const decluttered = () => {
    const scale = Math.pow(2, viewState?.zoom ?? 0);          // deck ortho: pixels per world unit at this zoom
    const cand = members.map((idx, c) => ({ c, label: dispLabel(labelOf(c)), full: labelOf(c), n: idx.length, p: centroid(idx) })).filter((d) => d.n > 0 && d.label).sort((a, b) => b.n - a.n);
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
  // A held SELECTION is the strongest emphasis source — it outranks focus and highlight, because the user
  // just asserted it by hand. Otherwise the existing focus → highlight precedence is untouched.
  const dimSet = () => (selSet ? selSet : focus != null ? fSet : highlight != null ? new Set(members[highlight]) : null);
  // EMPHASIS is a channel, distinct from ENCODING (eid-54lx). Attending to a card must not cost O(n):
  // the base cloud NEVER changes when focus/selection/highlight change — it dims as a whole via the layer
  // `opacity` uniform (one GPU uniform write, zero accessor re-runs), and the attended set is redrawn at
  // full strength by a tiny overlay layer whose data is just those indices. Click cost scales with the
  // emphasized set, not the corpus. deck 9 applies layer opacity as pow(opacity, 1/2.2) in the shader, so
  // 0.008 ≈ the old per-point dim alpha of 28/255 (0.11^2.2).
  const DIM_OPACITY = 0.008;
  const emphIdx = (): number[] => { const ds = dimSet(); if (!ds) return []; const out: number[] = []; for (const i of ds) if (i >= 0 && i < n && (!filterMask || filterMask[i])) out.push(i); return out; };

  // 3D uses deck.gl's OWN default OrbitController — drag rotates, scroll zooms — the battle-tested interaction
  // for a point cloud. No custom wheel-dolly, no bounds clamp, no dragMode override (those were blind patches
  // that fought each other). Just sensible defaults; we can add deliberate motion later, seeing it work.
  // In SELECT MODE the one-finger/pointer drag belongs to the lasso, so deck's drag gestures are switched
  // off: dragPan in 2D, and in 3D dragRotate too — which is CORRECT, not a compromise. A lasso is a
  // view-dependent gesture, so the view must hold still while it is drawn. PINCH is registered
  // independently by deck's recognizer, so two-finger zoom stays live on a phone throughout.
  const controllerFor = (l: Layout) => is3d(l)
    ? (selectMode ? { dragPan: false, dragRotate: false } : true)
    : { doubleClickZoom: false, inertia: true, dragPan: !selectMode };
  const view = () => (is3d(layout) ? new OrbitView({ id: "orbit" }) : new OrthographicView({ id: "ortho", flipY: false }));

  // A dot is ONE thing in every view: a pixel-radius disc sized by getRadius(), with the same min-pixel floor.
  // 2D and 3D differ only in the PROJECTION of its position (orthographic vs perspective) — never the dot. Depth
  // in 3D reads from motion parallax + occlusion as you orbit/dive, not from resizing dots (that was an ad-hoc
  // world-unit regime that made 3D dots ~4× the 2D ones — an isomorphism break). billboard keeps discs facing you.
  // STABLE data identities. deck diffs `data` by reference: a fresh `{ length: n }` per build would make
  // every paint() regenerate every attribute for all n points (the O(n) click cost eid-54lx measured),
  // silently defeating updateTriggers. One object for the layer's lifetime = deck trusts the triggers.
  const POINTS_DATA = { length: n };
  const CITE_DATA = (D.cite || []).flatMap((tgts, s) => tgts.map((t) => ({ s, t })));
  const pointsLayer = () => new ScatterplotLayer({
    id: "points", data: POINTS_DATA,
    getPosition: (_: any, { index }: any) => pos(index) as any,
    getFillColor: (_: any, { index }: any) => { const c = getColor(index); return [c[0], c[1], c[2], 255] as any; },
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels", radiusMinPixels: 1.2, billboard: true,
    opacity: dimSet() ? DIM_OPACITY : 1,  // emphasis dims the WHOLE base cloud via one uniform — never the per-point accessor
    // unified filter: GPU cull of any point the intersection mask marks 0 (filtered-out points also go
    // non-pickable). No mask = pass everything ([1,1] range with a constant 1 keeps all points in).
    extensions: [dataFilter],
    getFilterValue: (_: any, { index }: any) => (filterMask ? filterMask[index] : 1),
    filterRange: filterMask ? [0.5, 1.5] : [-1e30, 1e30],
    pickable: true, autoHighlight: n < 4000, highlightColor: [255, 255, 255, 180],
    transitions: { getPosition: { duration: dur(700), easing: easeCubicInOut } },
    updateTriggers: { getFillColor: colorVer, getRadius: [sizeVer, posVer], getPosition: posVer, getFilterValue: filterVer },
  });
  // the EMPHASIS overlay: only the attended indices, drawn full-strength above the dimmed base cloud.
  // Data size = |emphasized set| (focus+neighbours, a region, a selection) — independent of corpus size.
  // Not pickable: the base layer under it still owns picking with the same indices.
  const emphLayer = () => new ScatterplotLayer({
    id: "emph", data: emphIdx(),
    getPosition: (i: number) => pos(i) as any,
    getFillColor: (i: number) => { const c = getColor(i); return [c[0], c[1], c[2], 255] as any; },
    getRadius: (i: number) => getRadius(i),
    radiusUnits: "pixels", radiusMinPixels: 1.2, billboard: true, pickable: false,
    transitions: { getPosition: { duration: dur(700), easing: easeCubicInOut } },
    updateTriggers: { getFillColor: colorVer, getRadius: [sizeVer, posVer], getPosition: posVer },
  });
  const spokesLayer = () => new LineLayer({
    id: "spokes", data: focus == null ? [] : (D.nbr[focus] || []).map((j) => ({ j })),
    getSourcePosition: () => pos(focus as number) as any, getTargetPosition: (d: any) => pos(d.j) as any,
    getColor: spokeCol(), getWidth: 1,
    updateTriggers: { getSourcePosition: [posVer], getTargetPosition: [posVer], getColor: themeVer },
  });
  const hullPts = (): number[][] | null => {
    if (is3d(layout)) return null;
    const idx = highlight != null ? members[highlight] : null;
    return idx && idx.length >= 3 ? hull2d(idx.map((i) => pos(i))) : null;
  };
  const hullColor = (): RGB => col(highlight ?? 0);
  const hullLayer = () => { const h = hullPts(); return new PolygonLayer({
    id: "hull",
    data: h ? [h] : [],
    getPolygon: (d: any) => d, stroked: true, filled: true,
    getFillColor: [...hullColor(), 22] as any, getLineColor: [...hullColor(), 150] as any, getLineWidth: 1.5, lineWidthUnits: "pixels",
    updateTriggers: { data: [highlight, posVer], getFillColor: [highlight, themeVer], getLineColor: [highlight, themeVer] },
  }); };
  const labelLayer = () => new TextLayer({
    id: "labels",
    data: decluttered(),
    getPosition: (d: any) => d.p, getText: (d: any) => (d.c === hoverLabel ? d.full : d.label),
    getColor: (d: any) => [...col(d.c), highlight != null && d.c !== highlight ? 40 : 240] as any, getSize: 13, sizeUnits: "pixels",  // dim other regions' labels when one is isolated
    fontFamily: "ui-monospace, monospace", fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center", characterSet: "auto",   // default set is ASCII-only and silently DROPS the truncation ellipsis
    getPixelOffset: (d: any) => [d.dx || 0, 0],  // keep edge labels on-screen
    getBackgroundColor: labelBg(), background: true, backgroundPadding: [4, 2], pickable: true,
    updateTriggers: { getPosition: [posVer], data: [posVer], getColor: [highlight, themeVer], getText: [hoverLabel], getPixelOffset: [posVer], getBackgroundColor: themeVer },
  });
  // 3D region labels: billboarded at each region's 3D centroid, so the fly-through stays isomorphic with the
  // 2D map (same regions, colours, names — one mental map at a different angle). No screen-space declutter in
  // 3D (positions move with the camera) — just show them all, biggest-first; deck's depth sorts them.
  // region centroid in the ACTIVE 3D space — pos() so labels sit correctly in orbit (xyz) AND axes3d (axis coords)
  const centroid3 = (idx: number[]): number[] => { let x = 0, y = 0, z = 0; for (const i of idx) { const p = pos(i); x += p[0]; y += p[1]; z += p[2] || 0; } const k = idx.length || 1; return [x / k, y / k, z / k]; };
  const label3dLayer = () => new TextLayer({
    id: "labels",
    data: members.map((idx, c) => ({ c, label: dispLabel(labelOf(c)), full: labelOf(c), n: idx.length, p: centroid3(idx) })).filter((d) => d.n > 0 && d.label).sort((a, b) => b.n - a.n),
    getPosition: (d: any) => d.p, getText: (d: any) => (d.c === hoverLabel ? d.full : d.label),
    getColor: (d: any) => [...col(d.c), highlight != null && d.c !== highlight ? 70 : 245] as any, getSize: 14, sizeUnits: "pixels", sizeMaxPixels: 22, billboard: true,
    fontFamily: "ui-monospace, monospace", fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center", characterSet: "auto",
    getBackgroundColor: labelBg(), background: true, backgroundPadding: [4, 2], pickable: true,
    updateTriggers: { getPosition: [posVer, grain], data: [posVer, grain], getColor: [highlight, themeVer], getText: [hoverLabel], getBackgroundColor: themeVer },
  });
  // frontier telescope (only for --frontier arxiv corpora; absent otherwise): intra-corpus citation edges
  // + "ghost" papers cited-but-not-in-corpus, placed near the work that cites them, sized by citation count.
  const citeLayer = () => new LineLayer({
    id: "cite",
    data: CITE_DATA,
    getSourcePosition: (d: any) => pos(d.s) as any, getTargetPosition: (d: any) => pos(d.t) as any,
    getColor: [...ink(), 40] as any, getWidth: 0.6,
    updateTriggers: { getSourcePosition: [posVer], getTargetPosition: [posVer], getColor: themeVer },
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
    ...(dimSet() ? [emphLayer()] : []),
    // ghosts only have 2D placements (laid out near their citing work in the flat map) — drawing them at
    // xy in a 3D layout put them at wrong depths, floating in space. Honest: hide them outside 2D.
    ...(ghostsOn && D.ghosts && !is3d(layout) ? [ghostLayer()] : []),
    ...(showLabels ? [is3d(layout) ? label3dLayer() : labelLayer()] : []),
  ];

  let viewState: any = home(layout);
  // Keep the live layer array so the per-frame zoom handler can refresh ONLY the label layer (reveal-on-zoom)
  // instead of rebuilding the whole stack (incl. the 13k-pt cloud) every wheel tick — that was ~5fps at 13k
  // (measured, e2e/perf.ts). Reusing the other layer INSTANCES lets deck diff them as unchanged (no re-upload).
  let cur: any[] = layers();
  const paint = () => { cur = layers(); deck.setProps({ layers: cur }); };                                   // full rebuild (color/focus/layout change) — keeps `cur` fresh
  const paintLabels = () => { cur = cur.map((l: any) => (l && l.id === "labels" ? (is3d(layout) ? label3dLayer() : labelLayer()) : l)); deck.setProps({ layers: cur }); };
  const deck = new Deck({
    canvas, views: [view()], viewState,
    controller: controllerFor(layout), pickingRadius: 8,
    onViewStateChange: ({ viewState: vs }: any) => {
      const zoomed = Math.abs((vs?.zoom ?? 0) - (viewState?.zoom ?? 0)) > 0.08;
      viewState = vs; deck.setProps({ viewState });
      if (zoomed && showLabels) paintLabels();  // reveal/hide labels as zoom changes — label layer only, not the cloud
    },
    layers: cur,
    // NO deck onClick. deck routes clicks through its gesture recogniser, which holds every click for
    // its double-tap interval: MEASURED 316-329ms between pointerup and the card opening on the
    // 19,299-card map (2026-08-11), on top of ~80ms of picking. eid-54lx deleted OUR debounce for
    // exactly this reason and the library quietly put one back. The optimistic open that comment
    // describes now happens where it belongs — on the browser's own click event, below.
    onHover: (info: any) => {
      // region label under the pointer? swell it to its full name in place (and shrink the last one back)
      const overLabel = info?.layer?.id === "labels" && info.object ? (info.object.c as number) : null;
      if (overLabel !== hoverLabel) { hoverLabel = overLabel; if (showLabels) paintLabels(); }
      if (!init.onHover) return;
      if (info?.layer?.id === "ghosts" && info.object) init.onHover({ kind: "ghost", g: info.object }, info.x ?? 0, info.y ?? 0);
      else if (info?.layer?.id === "points" && info.index >= 0) init.onHover({ kind: "point", i: info.index }, info.x ?? 0, info.y ?? 0);
      else init.onHover(null, info?.x ?? 0, info?.y ?? 0);
    },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });


  // frame a set of points: 3D-aware — the bbox and the camera target track all three dims (the old 2D-only
  // version parked the orbit camera at depth 0 and framed by a flat extent, so isolating a region in 3D
  // mis-centred). Zoom fits the LARGEST extent, so the whole set is in frame at any rotation.
  const fit = (idx: number[]) => {
    if (!idx.length) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const i of idx) { const p = pos(i); if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; const z = p[2] ?? 0; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const b = Math.min(window.innerWidth, window.innerHeight), h = home(layout);
    const ext = Math.max(x1 - x0 || 0.1, y1 - y0 || 0.1, is3d(layout) ? z1 - z0 || 0.1 : 0);
    const zoom = Math.max(h.minZoom, Math.min(h.maxZoom, Math.log2((b * 0.6) / ext)));
    viewState = { ...viewState, target: [(x0 + x1) / 2, (y0 + y1) / 2, is3d(layout) ? (z0 + z1) / 2 : 0], zoom, transitionDuration: dur(500) };
    deck.setProps({ viewState });
  };
  // drill: step grain finer so the clicked region resolves into sub-clumps (gentle, ≤3 levels), fit to it.
  // Works in every layout — drilling only changes the grain (regions), never positions, and fit() is 3D-aware.
  const drill = (nodeIdx: number) => {
    const levels = D.levels; if (!levels) return;
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
  // THE CLICK, on the browser's own event — no gesture recogniser between the release and the card.
  // One pick, at the moment of the click (deck's own pick during pointerdown is its business; this is
  // the one whose answer we use). Labels stay click-transparent, ghosts still open their source.
  canvas.addEventListener("click", (e) => {
    if (selectMode) return;                          // in select mode the pointer draws; it does not open
    if (Date.now() < suppressClickUntil) return;     // the trailing click after a dblclick
    const x = (e as MouseEvent).offsetX, y = (e as MouseEvent).offsetY;
    let info: any = (deck as any).pickObject({ x, y, radius: 4 });
    if (info?.layer?.id === "labels") info = (deck as any).pickObject({ x, y, radius: 8, layerIds: ["points", "ghosts"] }) ?? info;
    if (info?.layer?.id === "ghosts" && info.object?.url) { window.open(info.object.url, "_blank"); return; }
    init.onClick?.(info?.layer?.id === "points" && info.index >= 0 ? info.index : -1);
  });
  canvas.addEventListener("dblclick", (e) => {
    if (selectMode) return;   // in select mode the pointer draws; it does not drill
    suppressClickUntil = Date.now() + 350;  // swallow the trailing click the browser fires right after a dblclick
    const info = (deck as any).pickObject({ x: (e as MouseEvent).offsetX, y: (e as MouseEvent).offsetY, radius: 8, layerIds: ["points"] });  // labels/ghosts never drill
    if (info && info.layer?.id === "points" && info.index >= 0) { init.onClick?.(-1); drill(info.index); }  // undo the optimistic card-open, then drill
  });
  return {
    update: (o) => {
      if (o.getColor) { getColor = o.getColor; colorVer++; }
      if (o.getRadius) { getRadius = o.getRadius; sizeVer++; }
      if (o.getX) getX = o.getX; if (o.getY) getY = o.getY; if (o.getZ) getZ = o.getZ;
      // posSig folds in the axis KEYS and their norm/invert props, so it bumps on a key change OR a prop-only
      // change (same key, new normalization) — the latter is what key-only comparison missed (points wouldn't move).
      if (o.posSig !== undefined && o.posSig !== posSig) { posSig = o.posSig; posVer++; }
      if (o.showLabels !== undefined) showLabels = o.showLabels;
      if (o.citeOn !== undefined) citeOn = o.citeOn;
      if (o.ghostsOn !== undefined) ghostsOn = o.ghostsOn;
      // a theme change re-inks the chrome layers (themeVer) AND repaints every point, because the
      // categorical palette itself is theme-derived (colorVer drives the points' getFillColor trigger).
      if (o.theme && o.theme !== theme) { theme = o.theme; setActiveTheme(theme); themeVer++; colorVer++; }
      if (o.grain !== undefined && o.grain !== grain) { grain = o.grain; recomputeGrain(); highlight = null; colorVer++; }  // grain change clears stale highlight
      const prev = layout;
      if (o.layout) layout = o.layout;
      if (layout !== prev) {
        posVer++;
        // Camera CONTINUITY on layout switch. The old behavior snapped viewState to home(layout) the moment
        // the view type changed, so the camera teleported to a new angle+zoom while the points were still
        // easing — the jarring "jump then slurp". The shapes morphing into each other is fine; the camera
        // teleporting is not. So: mde<->axes share a view — change nothing, let positions ease. Crossing
        // 2D->3D: swap the view but START the orbit camera flat (rotation 0) at the current target+zoom
        // (`zoom` means the same px-per-world-unit in both views), then EASE it to the tilted home while the
        // points rise off the plane. Crossing 3D->2D: flatten first — ease rotation to 0 in the orbit view
        // (points are already easing onto the z=0 plane), then swap to ortho at the same target+zoom and ease
        // to the 2D home frame. 3D<->3D (orbit vs axes3d = different world scales): ease to the new home.
        const interp = new LinearInterpolator(["target", "zoom", "rotationX", "rotationOrbit"] as any);
        const ease = { transitionDuration: dur(700), transitionInterpolator: interp, transitionEasing: easeCubicInOut };
        const t = viewState?.target ?? [0, 0, 0];
        if (is3d(layout) && !is3d(prev)) {
          const h = home(layout);
          viewState = { ...h, target: [t[0], t[1], h.target[2] ?? 0], zoom: viewState?.zoom ?? h.zoom, rotationX: 0, rotationOrbit: 0 };
          deck.setProps({ views: [view()], viewState, controller: controllerFor(layout) });
          // the ease must start on the NEXT frame: the new view id has no prior camera, and two setProps in
          // one tick collapse (deck diffs once per frame) — same-tick meant the flat start pose never rendered
          // and the camera snapped straight to home (verified live before this fix).
          requestAnimationFrame(() => { viewState = { ...h, ...ease }; deck.setProps({ viewState }); });
        } else if (!is3d(layout) && is3d(prev)) {
          const swap = () => {
            // keep the camera WHERE IT IS (target/zoom carry over; `zoom` = px per world unit in both views).
            // No re-zoom to home — continuity is the point; the user can reframe. (An ease-to-home here kept
            // getting cancelled by the leveling transition's echo and snapped instead — measured live.)
            const h = home(layout);
            const t2 = viewState?.target ?? [0, 0, 0];
            viewState = { ...h, target: [t2[0], t2[1], 0], zoom: viewState?.zoom ?? h.zoom };
            deck.setProps({ views: [view()], viewState, controller: controllerFor(layout) });
          };
          const level = dur(320);
          viewState = { ...viewState, rotationX: 0, rotationOrbit: 0, transitionDuration: level, transitionInterpolator: interp, transitionEasing: easeCubicInOut };
          deck.setProps({ viewState });
          setTimeout(swap, level + 20);  // after the leveling ease: the flat orbit view and the ortho view now agree
        } else if (is3d(layout) && is3d(prev)) {
          viewState = { ...home(layout), ...ease };
          deck.setProps({ viewState });
        }
      }
      paint();
    },
    // EMPHASIS setters (eid-54lx): no colorVer bump — the base cloud's colour buffer is encoding, and
    // attending must never invalidate it. paint() re-diffs the stack, but the points layer's accessors
    // are untouched (same updateTriggers), so deck re-uploads nothing for the n-point cloud.
    setFocus: (i) => { focus = i; fSet = i == null ? null : new Set<number>([i, ...(D.nbr[i] || [])]); paint(); },
    setHighlight: (c) => { highlight = c; paint(); },
    fitToIndices: (idx) => fit(idx),
    debug: () => ({ zoom: (deck.getViewports?.()?.[0] as any)?.zoom ?? viewState?.zoom ?? 0, labels: decluttered().length, regions: members.filter((m) => m.length).length, grain, rot: viewState?.rotationOrbit ?? null, rotX: viewState?.rotationX ?? null, target: viewState?.target ?? null, span3 }),
    project: (world) => { const vp = (deck as any).getViewports?.()[0]; return vp ? vp.project([world[0], world[1], world[2] ?? 0]).slice(0, 2) : [0, 0]; },  // honors z, so 3D layouts project correctly (was hardcoded z=0)
    projectIndex: (i) => { const vp = (deck as any).getViewports?.()[0]; if (!vp || i < 0 || i >= n) return null; const q = pos(i); return vp.project([q[0], q[1], q[2] ?? 0]); },
    pickAt: (x, y) => { const o = (deck as any).pickObject?.({ x, y, radius: 8 }); return o ? { layer: o.layer?.id ?? null, url: o.object?.url ?? null, index: o.index ?? -1 } : null; },
    setSelection: (idx) => { selSet = idx && idx.length ? new Set(idx) : null; paint(); },
    setSelectMode: (on) => { if (on === selectMode) return; selectMode = on; deck.setProps({ controller: controllerFor(layout) }); },
    // The camera-dependent half of SELECT, answered against the LIVE viewport: project every card with
    // deck's own viewport (OrbitViewport inherits project(), so 3D projects correctly) and crossing-test the
    // 2D result. clipZ only in 3D — that is the behind-the-camera guard (perspective w<0 mirrors a point
    // into the loop otherwise). The filter mask is respected: a hidden card is not selectable.
    selectPolygon: (path, mask) => {
      const vp = (deck as any).getViewports?.()[0];
      if (!vp) return [];
      return selectInPolygon({ count: n, positionOf: pos, project: (w) => vp.project(w), path, mask, clipZ: is3d(layout) });
    },
    resetView: () => { viewState = home(layout); deck.setProps({ viewState }); },
    // keyboard camera: pan in screen px (converted at the live zoom), zoom in deck zoom units (clamped to
    // the layout's own bounds), orbit in degrees (3D only — a 2D view has no rotation to change).
    panBy: (dxPx, dyPx) => {
      const scale = Math.pow(2, viewState?.zoom ?? 0) || 1;
      const t = viewState?.target ?? [0, 0, 0];
      viewState = { ...viewState, target: [t[0] + dxPx / scale, t[1] + dyPx / scale, t[2] ?? 0] };
      deck.setProps({ viewState });
    },
    zoomBy: (d) => {
      const h = home(layout);
      const z = Math.max(h.minZoom, Math.min(h.maxZoom, (viewState?.zoom ?? h.zoom) + d));
      viewState = { ...viewState, zoom: z };
      deck.setProps({ viewState });
      if (showLabels && !is3d(layout)) paintLabels();   // reveal-on-zoom parity with the wheel path
    },
    orbitBy: (dAz, dEl) => {
      if (!is3d(layout)) return;
      viewState = { ...viewState, rotationOrbit: (viewState?.rotationOrbit ?? 0) + dAz, rotationX: Math.max(-89, Math.min(89, (viewState?.rotationX ?? 0) + dEl)) };
      deck.setProps({ viewState });
    },
    drillIndex: (i) => { if (i >= 0 && i < n) drill(i); },
    getCamera: () => ({ target: (viewState?.target ?? [0, 0, 0]).slice(), zoom: viewState?.zoom ?? 0, rot: viewState?.rotationOrbit ?? null, rotX: viewState?.rotationX ?? null }),
    setCamera: (c) => {
      viewState = {
        ...viewState,
        ...(c.target ? { target: c.target } : {}),
        ...(c.zoom !== undefined ? { zoom: c.zoom } : {}),
        ...(is3d(layout) && c.rot != null ? { rotationOrbit: c.rot } : {}),
        ...(is3d(layout) && c.rotX != null ? { rotationX: c.rotX } : {}),
      };
      deck.setProps({ viewState });
    },
    setFilterMask: (mask) => { filterMask = mask; filterVer++; paint(); },
    destroy: () => deck.finalize(),
  };
}
