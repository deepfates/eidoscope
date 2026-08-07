// THE LASSO CORE — the device-agnostic half of SELECT. A gesture path (screen px) + a projector
// (world → screen) + the world positions = a frozen Set of card indices.
//
// Why EXTENSIONAL, not a re-evaluable predicate: a lasso in 3D depends on the camera. "the points inside
// this loop" only means something at the instant it was drawn; re-running it after an orbit would silently
// change the set under the user. So the gesture is transient and the RESULT is what we hold and share.
//
// Why not deck.pickObjects: it is viewport-clipped and occlusion-lossy (a point behind another point in the
// depth buffer is simply not returned). We already hold every position, so we project them ourselves and
// test the 2D result — every point inside the loop is selected, occluded or not.

// Ray-cast point-in-polygon (crossing number). 15 lines, no dependency: adding d3-polygon to pull in one
// function of this size would be the opposite of thin glue.
export function pointInPolygon(x: number, y: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A projector is anything that maps a world coord to screen px. deck's Viewport.project() returns
// [x, y, z] where z is the NDC depth — the guard below is the whole reason we keep the third component.
export type Projector = (world: number[]) => number[];

// Hit-test every card against the path.
//  - `mask` is the active filter mask: a hidden point is NOT selectable (you can only circle what you see).
//  - THE 3D GUARD: with a perspective camera (OrbitView), a point BEHIND the eye has w < 0 and its
//    projection mirrors through the origin — it lands inside the loop while sitting behind your head.
//    deck reports that as an out-of-range NDC z, so we accept only -1 <= z <= 1. In 2D (orthographic)
//    there is no behind-camera case and no clip plane to respect, so the guard is skipped.
export function selectInPolygon(opts: {
  count: number;
  positionOf: (i: number) => number[];
  project: Projector;
  path: number[][];
  mask?: ArrayLike<number> | null;
  clipZ?: boolean;                 // true for perspective (3D) views
}): number[] {
  const { count, positionOf, project, path, mask, clipZ } = opts;
  if (path.length < 3) return [];
  // a screen-space bbox first: one cheap reject before the O(edges) crossing test
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of path) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (mask && !mask[i]) continue;
    const p = positionOf(i);
    const s = project([p[0], p[1], p[2] ?? 0]);
    if (clipZ && s.length > 2 && !(s[2] >= -1 && s[2] <= 1)) continue;   // behind the camera / beyond the far plane
    const x = s[0], y = s[1];
    if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
    if (pointInPolygon(x, y, path)) out.push(i);
  }
  return out;
}
