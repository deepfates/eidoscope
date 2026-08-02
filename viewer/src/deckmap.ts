import { Deck, OrthographicView, OrbitView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MapContract } from "../../src/schema";
import type { RGB } from "./encode";

// The map's rendering + interaction core. deck.gl gives GPU rendering, a controller with pan / pinch-zoom
// / inertia (touch + mouse) + drag-rotate for orbit, and finger-sized picking. Encodings (colour/size)
// and layout (which positions + which view) arrive via update(); animated position transitions give the
// "smoosh" between layouts. Feature layers (hulls, labels, edges) compose on top in later tickets.

export type Layout = "mde" | "axes" | "orbit";
export type MapHandle = {
  deck: Deck;
  update: (o: Partial<Opts>) => void;
  resetView: () => void;
  destroy: () => void;
};
type Opts = { getColor: (i: number) => RGB; getRadius: (i: number) => number; layout: Layout; xKey: string; yKey: string };

export function createMap(canvas: HTMLCanvasElement, D: MapContract, init: Opts & { onClick?: (i: number) => void }): MapHandle {
  const n = D.ids.length;
  let { getColor, getRadius, layout, xKey, yKey } = init;
  let colorVer = 0, sizeVer = 0, posVer = 0;

  // fit the 2D neighbor-map coords
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of D.xy) { if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x; if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y; }
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) || 2;
  const fitZoom = Math.log2((Math.min(window.innerWidth, window.innerHeight) * 0.85) / span);
  // home camera per layout: neighbor-map fits its bbox; axis-scatter is the [-1,1] square; orbit is centered 3D.
  const home = (l: Layout) => l === "orbit"
    ? { target: [0, 0, 0], zoom: fitZoom - 0.5, rotationOrbit: 25, rotationX: 25, minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
    : l === "axes"
      ? { target: [0, 0, 0], zoom: Math.log2(Math.min(window.innerWidth, window.innerHeight) * 0.4), minZoom: fitZoom - 3, maxZoom: fitZoom + 9 }
      : { target: [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, 0], zoom: fitZoom, minZoom: fitZoom - 2, maxZoom: fitZoom + 9 };
  let viewState: any = home(layout);

  const pos = (index: number): number[] => {
    if (layout === "axes") return [((D.scores[xKey]?.[index] ?? 50) - 50) / 50, ((D.scores[yKey]?.[index] ?? 50) - 50) / 50];
    if (layout === "orbit") return [D.xyz[index][0], D.xyz[index][1], D.xyz[index][2]];
    return [D.xy[index][0], D.xy[index][1]];
  };

  const view = () => (layout === "orbit" ? new OrbitView({ orbitAxis: "Y", fovy: 50 }) : new OrthographicView({ flipY: false }));

  const layer = () => new ScatterplotLayer({
    id: "points",
    data: { length: n },
    getPosition: (_: any, { index }: any) => pos(index) as any,
    getFillColor: (_: any, { index }: any) => getColor(index) as any,
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels",
    radiusMinPixels: 1.2,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 180],
    transitions: { getPosition: { duration: 700 } },   // the "smoosh" between layouts
    updateTriggers: { getFillColor: colorVer, getRadius: sizeVer, getPosition: posVer },
  });

  const deck = new Deck({
    canvas,
    views: [view()],
    pickingRadius: 8,
    viewState,
    controller: { doubleClickZoom: false, inertia: true },
    onViewStateChange: ({ viewState: vs }: any) => { viewState = vs; deck.setProps({ viewState }); },
    layers: [layer()],
    onClick: (info: any) => { if (info && info.index >= 0 && init.onClick) init.onClick(info.index); },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });

  return {
    deck,
    update: (o) => {
      if (o.getColor) { getColor = o.getColor; colorVer++; }
      if (o.getRadius) { getRadius = o.getRadius; sizeVer++; }
      if (o.xKey && o.xKey !== xKey) { xKey = o.xKey; posVer++; }
      if (o.yKey && o.yKey !== yKey) { yKey = o.yKey; posVer++; }
      const layoutChanged = o.layout && o.layout !== layout;
      if (o.layout) layout = o.layout;
      if (layoutChanged) { posVer++; viewState = home(layout); deck.setProps({ views: [view()], viewState }); }
      deck.setProps({ layers: [layer()] });
    },
    resetView: () => { viewState = home(layout); deck.setProps({ viewState }); },
    destroy: () => deck.finalize(),
  };
}
