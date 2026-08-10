// docs/EIDO-FORMAT.md is verified against the codec: the doc's field tables are parsed and compared
// with (a) what encodeContainer actually emits for a fully-populated map, and (b) what a real fixture
// file contains. If a field is added/removed/renamed in the code, this test fails until the doc says so.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { encodeContainer, MAGIC } from "../src/eido-container.ts";
import { decodeMap } from "../src/mapbin.ts";
import { isMapContract, type MapContract } from "../src/schema.ts";

const doc = readFileSync(join(import.meta.dir, "../docs/EIDO-FORMAT.md"), "utf8");

// Pull the first-column code spans out of a markdown table that follows a marker line.
function tableKeys(marker: string): Set<string> {
  const start = doc.indexOf(marker);
  if (start < 0) throw new Error(`doc section not found: ${marker}`);
  // Take only the CONTIGUOUS table block after the marker, so the meta table never bleeds into the next table.
  const lines = doc.slice(start).split("\n");
  const first = lines.findIndex((l) => l.startsWith("| `"));
  const rows: string[] = [];
  for (let i = first; i >= 0 && i < lines.length && lines[i].startsWith("|"); i++) if (lines[i].startsWith("| `")) rows.push(lines[i]);
  const keys = new Set<string>();
  for (const row of rows) {
    const cell = row.split("|")[1];
    for (const m of cell.matchAll(/`([^`]+)`/g)) keys.add(m[1]);
  }
  if (!keys.size) throw new Error(`no table rows under: ${marker}`);
  return keys;
}
const docMetaKeys = tableKeys("Every key the encoder can emit");
const docBufKeys = tableKeys("Every buffer key the encoder can emit");

// A map exercising EVERY optional section, so the emitted meta/manifest carry every possible key.
function fullMap(): MapContract {
  const n = 3, dim = 4;
  const col = (v: number) => Array.from({ length: n }, () => v);
  return {
    provenance: { title: "t", source: "s", generated: 1, count: n },
    derivedBy: { cardModel: "m", embedder: { id: "e", dim }, geometryBasis: "card", pipelineVersion: "p", generated: 1 },
    metaFields: [{ key: "authors", label: "Author", type: "categorical", source: "col:authors" }],
    vectors: { data: new Float32Array(n * dim).fill(0.5), dim },
    colorCoords: [[0.1, 0.2], [-0.5, 0.5], [0.9, -0.1]],
    ids: ["a", "b", "c"], titles: ["A", "B", "C"], cores: ["ca", "cb", "cc"],
    notes: [{ x1: "na" }, { x1: "nb" }, { x1: "nc" }],
    axes: [{ key: "x1", name: "Axis", low: "lo", high: "hi" }],
    scores: { x1: col(50) }, rawScores: { x1: col(0.1) },
    xy: [[0, 0], [1, 1], [2, 2]], xyz: [[0, 0, 0], [1, 1, 1], [2, 2, 2]], xyzAgree: 4,
    cluster: [0, 0, 1], k: 2, di: 0, levels: [[0, 0, 1]], counts: [2],
    levelLabels: [["r0", "r1"]], levelBlurbs: [["b0", "b1"]],
    clusters: [{ c: 0, n: 2, label: "r0" }, { c: 1, n: 1, label: "r1" }],
    hub: col(1), nbr: [[1], [0], [0]], cite: [[1], [], []], citec: col(0),
    urls: ["u", undefined, "u"], sources: ["s", undefined, undefined], siteNames: ["n", undefined, undefined],
    authors: ["me", undefined, undefined], tags: [["t"], undefined, undefined], dates: [1, undefined, undefined],
    read: [true, undefined, undefined], folders: ["f", undefined, undefined],
    ghosts: [{ title: "g", arxiv: "1", url: "u", n: 1, core: "c", xy: [0, 0], sim: 0.5 }],
    views: [{ name: "v", created: 1, state: { layout: "mde" } }],
    cols: [
      { key: "score", label: "score", type: "scalar", values: [7.1, undefined, 3] },
      { key: "published", label: "published", type: "temporal", values: [1700000000001, undefined, 1700000060002] },
      { key: "genre", label: "genre", type: "categorical", multi: true, values: [["rock", "pop"], undefined, ["jazz"]] },
      { key: "verified", label: "verified", type: "boolean", values: [true, false, undefined] },
    ],
  };
}

function parseMeta(container: Uint8Array) {
  expect(new TextDecoder().decode(container.subarray(0, 8))).toBe(MAGIC);
  const metaLen = new DataView(container.buffer, container.byteOffset).getUint32(8, true);
  return JSON.parse(new TextDecoder().decode(container.subarray(12, 12 + metaLen)));
}

describe("EIDO-FORMAT.md matches the codec", () => {
  const meta = parseMeta(encodeContainer(fullMap()));

  test("documented meta keys === keys a full emit produces (ONE format — v2.2, no legacy keys)", () => {
    const emitted = new Set<string>(Object.keys(meta));
    expect([...docMetaKeys].sort()).toEqual([...emitted].sort());
  });

  test("documented buffer keys === manifest of a full emit", () => {
    const emitted = new Set<string>(meta.buffers.map((b: any) => b.key));
    expect([...docBufKeys].sort()).toEqual([...emitted].sort());
  });

  test("documented buffer types match the manifest", () => {
    const types: Record<string, string> = {};
    for (const b of meta.buffers) types[b.key] = b.type;
    // re-parse the doc's buffer table rows: `key` | type
    const start = doc.indexOf("Every buffer key the encoder can emit");
    for (const row of doc.slice(start).split("\n").filter((l) => l.startsWith("| `"))) {
      const cells = row.split("|");
      const type = cells[2].trim();
      for (const m of cells[1].matchAll(/`([^`]+)`/g)) expect(`${m[1]}:${types[m[1]]}`).toBe(`${m[1]}:${type}`);
    }
  });

  test("the real fixture stays within the documented field sets", () => {
    const gz = readFileSync(join(import.meta.dir, "fixtures/example.eido"));
    const container = gunzipSync(gz);
    const fmeta = parseMeta(container);
    for (const k of Object.keys(fmeta)) expect(docMetaKeys.has(k)).toBe(true);
    for (const b of fmeta.buffers) expect(docBufKeys.has(b.key)).toBe(true);
    expect(isMapContract(decodeMap(gz))).toBe(true);
  });

  test("wire layout facts as documented: metaLen at 8, 4-byte padding, aligned offsets", () => {
    const container = encodeContainer(fullMap());
    const metaLen = new DataView(container.buffer).getUint32(8, true);
    expect((12 + metaLen + ((4 - (metaLen % 4)) % 4)) % 4).toBe(0);
    for (const b of meta.buffers) expect(b.offset % 4).toBe(0);
  });
});
