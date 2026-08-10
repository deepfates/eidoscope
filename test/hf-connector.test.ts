// The HuggingFace connector's PURE parts (eid-ilc5): id parsing and the rows→IngestFile mapping,
// plus the seam guarantee — the files it emits go through docsFromFiles like any other corpus, so
// the floor/dedupe rules apply for free. Network paths are covered by e2e/hf.e2e.ts (mocked edge)
// and one live-pull receipt.
import { describe, expect, test } from "bun:test";
import { parseDatasetId, rowsToFiles } from "../viewer/src/connectors/huggingface";
import { docsFromFiles } from "../src/corpus-core";

describe("parseDatasetId", () => {
  test("plain ids and URLs", () => {
    expect(parseDatasetId("stanfordnlp/imdb")).toBe("stanfordnlp/imdb");
    expect(parseDatasetId("  squad ")).toBe("squad");
    expect(parseDatasetId("https://huggingface.co/datasets/fka/awesome-chatgpt-prompts")).toBe("fka/awesome-chatgpt-prompts");
    expect(parseDatasetId("https://huggingface.co/datasets/stanfordnlp/imdb/viewer/plain_text/train")).toBe("stanfordnlp/imdb");
    expect(parseDatasetId("huggingface.co/datasets/user/name/")).toBe("user/name");
  });
  test("garbage refused", () => {
    expect(parseDatasetId("")).toBeNull();
    expect(parseDatasetId("a/b/c")).toBeNull();
    expect(parseDatasetId("https://example.com/whatever")).toBeNull();
  });
});

describe("rowsToFiles", () => {
  const p = { dataset: "user/ds", config: "default", split: "train", idColumn: undefined as string | undefined };
  const long = "x".repeat(300);

  test("titles from dataset+row index; frontmatter id/title; parseable by docsFromFiles", () => {
    const files = rowsToFiles(p, [{ row_idx: 7, row: { text: long } }], "text");
    expect(files[0].name).toBe("row-7.md");
    expect(files[0].path).toBe("hf://user/ds/default/train/row-7.md");
    const docs = docsFromFiles(files, { warn: () => {} });
    expect(docs.length).toBe(1);
    expect(docs[0].id).toBe("hf-7");
    expect(docs[0].title).toBe("user/ds · row 7");
    expect(docs[0].body).toBe(long);
  });

  test("id column becomes the title when present", () => {
    const files = rowsToFiles({ ...p, idColumn: "title" }, [{ row_idx: 0, row: { title: 'A "quoted"\ntitle', text: long } }], "text");
    const docs = docsFromFiles(files, { warn: () => {} });
    expect(docs[0].title).toBe("A quoted title");
  });

  test("corpus rules come free: the 200-char floor drops short rows, dedupe drops twins", () => {
    const rows = [
      { row_idx: 0, row: { text: "too short" } },
      { row_idx: 1, row: { text: long } },
      { row_idx: 2, row: { text: long } },          // different title → kept (not an exact twin)
    ];
    const warns: string[] = [];
    const docs = docsFromFiles(rowsToFiles(p, rows, "text"), { warn: (l) => warns.push(l) });
    expect(docs.length).toBe(2);
    expect(warns.join(" ")).toContain("under 200 chars");
  });

  test("missing column values become empty (then floored), not a crash", () => {
    const docs = docsFromFiles(rowsToFiles(p, [{ row_idx: 0, row: {} }], "text"), { warn: () => {} });
    expect(docs.length).toBe(0);
  });
});

// ── METADATA COLUMNS (eid-xmf0): every non-text column rides IngestFile.meta → Doc.meta → buildCols ──
import { buildCols } from "../src/geometry";

describe("row metadata → the generic column store", () => {
  const p = { dataset: "user/ds", config: "default", split: "train", idColumn: undefined as string | undefined };
  const long = "x".repeat(300);

  test("rowsToFiles carries every non-text primitive column; blobs/objects are skipped", () => {
    const files = rowsToFiles(p, [{ row_idx: 0, row: { text: long, score: 7.3, artist: "Pixies", genre: "rock, indie", ok: true, blob: { deep: 1 } } }], "text");
    expect(files[0].meta).toEqual({ score: 7.3, artist: "Pixies", genre: "rock, indie", ok: true });
    const docs = docsFromFiles(files, { warn: () => {} });
    expect(docs[0].meta).toEqual({ score: 7.3, artist: "Pixies", genre: "rock, indie", ok: true });
  });

  test("buildCols infers types by looking at the values: number→scalar, boolean→boolean, ISO date→temporal, string→categorical", () => {
    const metas = Array.from({ length: 10 }, (_, i) => ({
      score: i * 1.5,
      ok: i % 2 === 0,
      published: `2020-0${(i % 9) + 1}-01T00:00:00Z`,
      artist: "artist-" + (i % 3),
    }));
    const cols = buildCols(metas);
    const by = Object.fromEntries(cols.map((c) => [c.key, c]));
    expect(by.score.type).toBe("scalar");
    expect(by.score.values[2]).toBe(3);
    expect(by.ok.type).toBe("boolean");
    expect(by.published.type).toBe("temporal");
    expect(by.published.values[0]).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(by.artist.type).toBe("categorical");
  });

  test("comma-multivalue is detected by sampling, not by name: label-like tokens split, prose does not", () => {
    const metas = Array.from({ length: 20 }, (_, i) => ({
      genre: i % 2 === 0 ? "rock, indie" : "pop",
      blurb: `a long descriptive sentence, with a comma, that keeps rambling on about topic ${i} in a way no genre tag ever would because these clauses run far past any label length`,
    }));
    const cols = buildCols(metas);
    const by = Object.fromEntries(cols.map((c) => [c.key, c]));
    expect(by.genre.multi).toBe(true);
    expect(by.genre.values[0]).toEqual(["rock", "indie"]);
    expect(by.genre.values[1]).toEqual(["pop"]);
    expect(by.blurb.multi).toBeUndefined();
    expect(typeof by.blurb.values[0]).toBe("string");
  });

  test("holes and empty columns: missing values stay undefined; an all-empty key builds no column", () => {
    const metas: (Record<string, unknown> | undefined)[] = [{ score: 1 }, undefined, { score: 3, ghost: null }];
    const cols = buildCols(metas);
    expect(cols.length).toBe(1);
    expect(cols[0].values).toEqual([1, undefined, 3]);
  });
});

// ── NAMESPACE COLLISION (codex finding): a generic column named like a native field must NOT shadow it ──
import { buildMetaFields } from "../src/geometry";
import { buildDimensions } from "../viewer/src/dimensions";
import { synthMap } from "../e2e/synth";

describe("mcol: vs col: — disjoint source namespaces", () => {
  test("an incoming `author` column yields BOTH dimensions, native intact, each resolving its own data", () => {
    const D = synthMap();                       // carries native authors ("Author 0..3")
    const n = D.ids.length;
    D.cols = [
      // deliberately collides with the native author dimension's minted key AND the authors field's name
      { key: "author", label: "author", type: "categorical", values: Array.from({ length: n }, (_, i) => "gen-" + (i % 2)) },
      { key: "authors", label: "authors", type: "categorical", values: Array.from({ length: n }, (_, i) => "col-" + (i % 3)) },
    ];
    D.metaFields = buildMetaFields(D);
    // sources are unambiguous: native reads col:authors, generic reads mcol:<key> — never each other
    const native = D.metaFields.find((f) => f.key === "author")!;
    const genA = D.metaFields.find((f) => f.source === "mcol:author")!;
    const genB = D.metaFields.find((f) => f.source === "mcol:authors")!;
    expect(native.source).toBe("col:authors");
    expect(genA.key).toBe("author·col");        // display key deduped; source untouched
    expect(genB.key).toBe("authors");
    const dims = buildDimensions(D);
    const dim = (k: string) => dims.find((d) => d.key === k)!;
    expect(dim("author").cat!(0)).toBe("Author 0");       // native values, reachable, un-shadowed
    expect(dim("author·col").cat!(0)).toBe("gen-0");      // generic values under the deduped key
    expect(dim("authors").cat!(1)).toBe("col-1");
  });
});
