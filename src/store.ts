// The READ seam — how a mounted map is consumed. Pure and host-free (like eido-container.ts): the
// browser viewer reads through this, and a node tool can too.
//
// What the viewer actually consumes today is two things, and the interface says exactly that, no more:
//   · map()     — the full MapContract (positions, cards, scores, regions…), materialized. The whole
//                 renderer/model layer reads plain contract fields.
//   · vectors() — the carried card-vector matrix, read in bulk by the operators (DERIVE's delta-centroid,
//                 QUERY's cosine ranking).
// EmbeddedStore is the current regime: the container is decoded fully into memory, so both accessors
// are free. A ColumnarStore (map file + local substrate, at scale) implements the SAME interface by
// serving map() from the small map file and vectors() from the substrate — the honest cost of that
// future is that map() stays "the whole contract"; slicing the contract into per-field accessors is
// ColumnarStore's job to force, not something to fake before it exists.
import type { CardVectors, MapContract } from "./schema.ts";

export interface Store {
  readonly n: number;                       // node count
  map(): MapContract;                       // the mounted contract (everything node-indexed lives here)
  vectors(): CardVectors | undefined;       // the re-interrogation substrate (absent in a "lite" emit)
}

// The current implementation: a fully-decoded in-memory contract (viewer loader, pipeline decodeMap).
export class EmbeddedStore implements Store {
  constructor(private D: MapContract) {}
  get n() { return this.D.ids.length; }
  map() { return this.D; }
  vectors() { return this.D.vectors; }
}
