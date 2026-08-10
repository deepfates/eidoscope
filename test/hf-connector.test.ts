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
