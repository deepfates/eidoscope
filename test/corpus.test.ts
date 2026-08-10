import { test, expect } from "bun:test";
import { frontMeta, docsFromFiles } from "../src/corpus-core.ts";

// eid-ovsw: a folder's OWN frontmatter must ride the same generic metadata path a dataset column
// does — every key the parser doesn't lift into a named contract field becomes doc.meta, so any
// corpus (not just HuggingFace) can be coloured/faceted/windowed by what its files actually carry.
test("frontMeta: every non-lifted frontmatter key becomes generic metadata, typed from its value", () => {
  const front = [
    "title: Lifted Away", "url: https://x/y", "author: kim", "tags: [a, b]",   // lifted → NOT in meta
    "context_length: 128000",                                                   // number
    "supports_vision: true",                                                    // boolean
    "provider: anthropic",                                                      // string
    "released: 2026-03-01",                                                     // ISO-ish string (buildCols infers temporal)
    "price_per_mtok: 3.5",                                                      // float
    "modalities: [text, image]",                                                // inline list
    "capabilities:", "  - tools", "  - json",                                   // block list
    "nested:", "  deep: skipped",                                               // nested map → skipped, not half-parsed
  ].join("\n");
  const m = frontMeta(front);
  expect(m.context_length).toBe(128000);
  expect(m.supports_vision).toBe(true);
  expect(m.provider).toBe("anthropic");
  expect(m.released).toBe("2026-03-01");
  expect(m.price_per_mtok).toBe(3.5);
  expect(m.modalities).toEqual(["text", "image"]);
  expect(m.capabilities).toEqual(["tools", "json"]);
  for (const lifted of ["title", "url", "author", "tags"]) expect(m[lifted]).toBeUndefined();
  expect(m.deep).toBeUndefined();          // nested values never leak to the top level
});

test("docsFromFiles: frontmatter metadata reaches the doc, and connector metadata wins per key", () => {
  const file = (name: string, front: string, body: string) => ({ path: name, name, text: `---\n${front}\n---\n\n${body}` });
  const long = "word ".repeat(80);
  const [d] = docsFromFiles([file("m.md", "title: T\nprovider: anthropic\ncontext_length: 200000", long)], { warn: () => {} });
  expect(d.meta).toEqual({ provider: "anthropic", context_length: 200000 });
  const [d2] = docsFromFiles([{ ...file("m2.md", "provider: anthropic\nrank: 1", long), meta: { provider: "openai", extra: "row" } }], { warn: () => {} });
  expect(d2.meta).toEqual({ provider: "openai", rank: 1, extra: "row" });   // connector wins, frontmatter fills
});
