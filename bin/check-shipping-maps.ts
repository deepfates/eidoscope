// Deploy tripwire: a falsifier's scratch corpus once overwrote viewer/public/map.eido and SHIPPED to
// prod under the Readwise name (2026-08-09). Every map we ship must decode and be the corpus its
// filename claims — the floor of 1000 cards is an ops tripwire (all three real corpora clear it by
// an order of magnitude), not data ontology.
import { decodeMap } from "../src/mapbin.ts";
import { readFileSync } from "fs";
const SHIP = [ ["viewer/public/map.eido", "readwise"], ["viewer/public/pathfinder.eido", "pathfinder"], ["viewer/public/tldr.eido", "tldr"] ] as const;
let bad = 0;
for (const [p, name] of SHIP) {
  try {
    const D = decodeMap(readFileSync(p));
    if (D.ids.length < 1000) { console.error(`✗ ${p} (${name}) has only ${D.ids.length} cards — looks like a scratch/test map, refusing to ship`); bad++; }
    else console.error(`✓ ${p} (${name}): ${D.ids.length} cards, ${D.k} regions — ${D.provenance?.title ?? "untitled"}`);
  } catch (e) { console.error(`✗ ${p} (${name}) does not decode: ${e instanceof Error ? e.message : e}`); bad++; }
}
if (bad) process.exit(1);
