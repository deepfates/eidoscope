import { readFileSync } from "node:fs";
import { decodeMap } from "../src/mapbin.ts";
const D: any = decodeMap(new Uint8Array(readFileSync("out/pitchfork/pitchfork.eido")));
const axKeys = (D.axes ?? []).map((a: any) => a.key);
let card = 0, n = 0;
for (let i = 0; i < D.ids.length; i++) {
  const notes = axKeys.map((k: string) => D.notes?.[i]?.[k] || "").filter(Boolean).join(". ");
  card += (D.titles[i]?.length ?? 0) + (D.cores[i]?.length ?? 0) + notes.length; n++;
}
console.log(`cards: ${n}`);
console.log(`avg CARD OUTPUT chars/card: ${(card / n).toFixed(0)}  (~${(card / n / 4).toFixed(0)} tokens at 4 chars/token)`);
console.log(`report says 91,283 completion tokens for the calls that actually ran that pass`);
