// The URL id-set codec (eid-0iql): a selection / derived-axis example set rides as delta-encoded sorted
// indices + a checksum of the ids they name. These tests pin the round-trip, the honesty guards (checksum
// mismatch drops the whole set; legacy ids drop individually), and the SIZE claim the cap is built on.
import { describe, expect, test } from "bun:test";
import { encodeIdxSet, decodeIdxSet, fnv1a, parseIdSet, resolveIdSet } from "../viewer/src/idset";

const rand = (() => { let s = 1234; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const pick = (n: number, k: number) => { const a = new Set<number>(); while (a.size < k) a.add((rand() * n) | 0); return [...a]; };

describe("idset codec", () => {
  test("round-trips arbitrary index sets, order- and duplicate-insensitive", () => {
    for (const [n, k] of [[90, 30], [1000, 141], [5000, 500], [20000, 1000]] as const) {
      const idx = pick(n, k);
      const dec = decodeIdxSet(encodeIdxSet(idx, 7))!;
      expect(dec.idx).toEqual([...new Set(idx)].sort((a, b) => a - b));
      expect(dec.sum).toBe(7);
    }
    expect(decodeIdxSet(encodeIdxSet([5, 2, 5, 0], 0xdeadbeef))!.idx).toEqual([0, 2, 5]);
    expect(decodeIdxSet(encodeIdxSet([5, 2, 5, 0], 0xdeadbeef))!.sum).toBe(0xdeadbeef);
  });

  test("parseIdSet: `*<b64>` decodes, garbage is null, anything else is legacy ids", () => {
    const enc = "*" + encodeIdxSet([1, 3], fnv1a("b,d"));
    expect(parseIdSet(enc)).toEqual({ idx: [1, 3], sum: fnv1a("b,d") });
    expect(parseIdSet("*!!!")).toBeNull();
    expect(parseIdSet("id1,id2,")).toEqual({ ids: ["id1", "id2"] });
    expect(parseIdSet("")).toBeNull();
  });

  test("resolve: checksum agreement restores the exact set; disagreement drops it WHOLE", () => {
    const corpus = ["a", "b", "c", "d", "e"];
    const idx = [1, 3, 4];
    const ok = parseIdSet("*" + encodeIdxSet(idx, fnv1a("b,d,e")))!;
    expect(resolveIdSet(ok, corpus)).toEqual(idx);
    // same length, different corpus — indices would name the WRONG cards; the whole set drops
    expect(resolveIdSet(ok, ["a", "B", "c", "D", "E"])).toBeNull();
    // out-of-range index (a smaller regenerated corpus) drops too
    expect(resolveIdSet(parseIdSet("*" + encodeIdxSet([9], fnv1a("x")))!, corpus)).toBeNull();
  });

  test("resolve: legacy comma ids drop missing ids individually (old links keep working)", () => {
    expect(resolveIdSet({ ids: ["d30", "d31", "nosuchcard"] }, ["d30", "d31", "d32"])).toEqual([0, 1]);
    expect(resolveIdSet({ ids: ["ghost"] }, ["d30"])).toBeNull();
  });

  // THE MEASUREMENT the SET_PARAM_CAP in model.svelte.ts rests on: ≤2 chars/card at realistic corpus
  // sizes, so 1,800 chars of payload carries ≥900 cards even at the thinnest measured density (it is
  // ~1.34/card for large sets → ≈1,300). If the encoding regresses past this, the cap's comment is a lie.
  test("density: ≤2 chars per card for 141–1000-card sets in 500–20,000-card corpora", () => {
    for (const [n, k] of [[500, 141], [1000, 200], [5000, 500], [20000, 1000]] as const) {
      const enc = encodeIdxSet(pick(n, k), 1);
      expect(enc.length / k).toBeLessThanOrEqual(2);
    }
    // the prod case from the ticket: 141 cards was 6,758 URL bytes spelled out; encoded it is ~200 chars
    expect(encodeIdxSet(pick(1000, 141), 1).length).toBeLessThan(280);
  });
});
