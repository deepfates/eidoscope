import { Deck, OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MapContract } from "../../src/schema";
import type { RGB } from "./encode";

// The map's rendering + interaction core. deck.gl gives GPU rendering (100k+ points), a controller that
// does pan / pinch-zoom / inertia on touch AND mouse, and finger-sized picking. Encodings (what colour/
// size mean) live in encode.ts and arrive as accessor functions via update() — this module owns only the
// points layer + camera. Feature layers (hulls, labels, edges) and the Svelte panel compose on top.

export type MapHandle = {
  deck: Deck;
  update: (o: { getColor?: (i: number) => RGB; getRadius?: (i: number) => number }) => void;
  resetView: () => void;
  destroy: () => void;
};

export function createMap(
  canvas: HTMLCanvasElement,
  D: MapContract,
  opts: { getColor: (i: number) => RGB; getRadius: (i: number) => number; onClick?: (i: number) => void },
): MapHandle {
  const n = D.ids.length;
  let getColor = opts.getColor, getRadius = opts.getRadius;
  let colorVer = 0, sizeVer = 0;

  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of D.xy) { if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 2;
  const fitZoom = Math.log2((Math.min(window.innerWidth, window.innerHeight) * 0.85) / span);
  const home = { target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0], zoom: fitZoom, minZoom: fitZoom - 2, maxZoom: fitZoom + 9 };
  let viewState: any = { ...home };

  const layer = () => new ScatterplotLayer({
    id: "points",
    data: { length: n },
    getPosition: (_: any, { index }: any) => [D.xy[index][0], D.xy[index][1]] as [number, number],
    getFillColor: (_: any, { index }: any) => getColor(index) as any,
    getRadius: (_: any, { index }: any) => getRadius(index),
    radiusUnits: "pixels",
    radiusMinPixels: 1.2,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 180],
    updateTriggers: { getFillColor: colorVer, getRadius: sizeVer },
  });

  const deck = new Deck({
    canvas,
    views: [new OrthographicView({ flipY: false })],
    pickingRadius: 8,
    viewState,
    controller: { doubleClickZoom: false, inertia: true, touchRotate: false },
    onViewStateChange: ({ viewState: vs }: any) => { viewState = vs; deck.setProps({ viewState }); },
    layers: [layer()],
    onClick: (info: any) => { if (info && info.index >= 0 && opts.onClick) opts.onClick(info.index); },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });

  return {
    deck,
    update: ({ getColor: gc, getRadius: gr }) => {
      if (gc) { getColor = gc; colorVer++; }
      if (gr) { getRadius = gr; sizeVer++; }
      deck.setProps({ layers: [layer()] });
    },
    resetView: () => { viewState = { ...home }; deck.setProps({ viewState }); },
    destroy: () => deck.finalize(),
  };
}
