import { Deck, OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MapContract } from "../../src/schema";

// The map's rendering + interaction core. deck.gl gives us GPU rendering (100k+ points), a controller
// that does pan / pinch-zoom / inertia on touch AND mouse, and finger-sized picking — the things the
// hand-rolled canvas couldn't. This module owns ONLY the points layer + camera; feature layers (hulls,
// labels, edges) and the Svelte control panel compose on top in later tickets.

// colourblind-safe categorical palette (matches the old viewer's identity); cycles past its length —
// identity is carried by position + labels + isolate, not colour alone (see the old render.ts note).
const PAL: [number, number, number][] = [
  [57, 135, 229], [217, 89, 38], [25, 158, 112], [201, 133, 0],
  [213, 81, 129], [0, 131, 0], [144, 133, 233], [230, 103, 103],
];
const col = (c: number) => PAL[((c % PAL.length) + PAL.length) % PAL.length];

export type MapHandle = {
  deck: Deck;
  setViewState: (vs: any) => void;
  destroy: () => void;
};

export function createMap(canvas: HTMLCanvasElement, D: MapContract, opts: { onClick?: (i: number) => void } = {}): MapHandle {
  const n = D.ids.length;
  const maxHub = Math.max(1, ...D.hub);
  // fit the [-1,1]-ish normalized coords: OrthographicView zoom is log2(pixels per world-unit).
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of D.xy) { if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 2;
  const fitZoom = Math.log2((Math.min(window.innerWidth, window.innerHeight) * 0.85) / span);

  let viewState: any = { target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0], zoom: fitZoom, minZoom: fitZoom - 2, maxZoom: fitZoom + 9 };

  const pointsLayer = () => new ScatterplotLayer({
    id: "points",
    data: { length: n },                       // index-based: accessors read the typed columns by index
    getPosition: (_: any, { index }: any) => [D.xy[index][0], D.xy[index][1]] as [number, number],
    getFillColor: (_: any, { index }: any) => col(D.cluster[index]) as any,
    getRadius: (_: any, { index }: any) => 1.5 + 3.4 * Math.sqrt((D.hub[index] || 0) / maxHub),
    radiusUnits: "pixels",
    radiusMinPixels: 1.5,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 180],
    updateTriggers: {},
  });

  const deck = new Deck({
    canvas,
    views: [new OrthographicView({ flipY: false })],
    pickingRadius: 8,                                   // finger-sized hit tolerance — fixes tiny tap targets
    viewState,
    controller: { doubleClickZoom: false, inertia: true, touchRotate: false },   // pan + pinch-zoom + inertia
    onViewStateChange: ({ viewState: vs }: any) => { viewState = vs; deck.setProps({ viewState }); },
    layers: [pointsLayer()],
    onClick: (info: any) => { if (info && info.index >= 0 && opts.onClick) opts.onClick(info.index); },
    getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  });

  return {
    deck,
    setViewState: (vs) => { viewState = vs; deck.setProps({ viewState }); },
    destroy: () => deck.finalize(),
  };
}
