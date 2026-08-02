import { Deck, OrthographicView, OrbitView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MapContract } from "../../src/schema";
import type { RGB } from "./encode";

// The map's rendering + interaction core. ONE Deck for its whole life (so canvas pointer capture is never
// lost); layout switches swap the view + camera via setProps. deck.gl gives GPU rendering, a controller
// with pan/pinch-zoom/inertia (2D) or drag-rotate (3D OrbitView), and finger-sized picking. Encodings +
// layout arrive via update(); positions animate between 2D layouts (the "smoosh").

export type Layout = "mde" | "axes" | "orbit";
export type MapHandle = { update: (o: Partial<Opts>) => void; resetView: () => void; destroy: () => void };
type Opts = { getColor: (i: number) => RGB; getRadius: (i: number) => number; layout: Layout; xKey: string; yKey: string };

export function createMap(canvas: HTMLCanvasElement, D: MapContract, init: Opts & { onClick?: (i: number) => void }): MapHandle {
  const n = D.ids.length;
  let { getColor, getRadius, layout, xKey, yKey } = init;
  let colorVer = 0, sizeVer = 0, posVer = 0;

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
  // Orbit needs a stable id so a controlled viewState maps to it; give BOTH views ids so deck rebuilds the
  // controller when the id changes on a layout swap (this is what makes drag actually rotate in orbit).
  const view = () => (layout === "orbit" ? new OrbitView({ id: "orbit", orbitAxis: "Y", fovy: 50 }) : new OrthographicView({ id: "ortho", flipY: false }));
  const layer = () => new ScatterplotLayer({
    id: "points", data: { length: n },
    getPosition: (_: any, { index }: any) => pos(index) as any,
    getFillColor: (_: any, { index }: any) => getColor(index) as any,
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels", radiusMinPixels: 1.2,
    billboard: true,   // always face the camera → round dots at any orbit angle (not flat discs tilting to ellipses)
    pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 180],
    transitions: { getPosition: { duration: 700 } },
    updateTriggers: { getFillColor: colorVer, getRadius: sizeVer, getPosition: posVer },
  });

  let viewState: any = home(layout);
  const deck = new Deck({
    canvas,
    views: [view()],
    viewState,
    controller: { doubleClickZoom: false, inertia: true },
    pickingRadius: 8,
    onViewStateChange: ({ viewState: vs }: any) => { viewState = vs; deck.setProps({ viewState }); },
    layers: [layer()],
    onClick: (info: any) => { if (info && info.index >= 0 && init.onClick) init.onClick(info.index); },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });

  return {
    update: (o) => {
      if (o.getColor) { getColor = o.getColor; colorVer++; }
      if (o.getRadius) { getRadius = o.getRadius; sizeVer++; }
      if (o.xKey && o.xKey !== xKey) { xKey = o.xKey; posVer++; }
      if (o.yKey && o.yKey !== yKey) { yKey = o.yKey; posVer++; }
      const prev = layout;
      if (o.layout) layout = o.layout;
      if (layout !== prev) { posVer++; viewState = home(layout); deck.setProps({ views: [view()], viewState }); }
      deck.setProps({ layers: [layer()] });
    },
    resetView: () => { viewState = home(layout); deck.setProps({ viewState }); },
    destroy: () => deck.finalize(),
  };
}
