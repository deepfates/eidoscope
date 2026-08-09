// The document lifecycle's pure seams (eid-cawh · eid-4ii9): the browser's Save payload is the SAME
// bytes the pipeline emits (fflate gzip over the shared encodeContainer — decode must return every
// stratum: source truth, caches, and the work in views), and the Export artifacts (vault zip entries,
// deck JSONL, single-file inject) come from src/export.ts — the one emit both hosts share.
import { test, expect } from "bun:test";
import { gzipSync, gunzipSync, zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { encodeContainer, decodeContainer } from "../src/eido-container.ts";
import { vaultEntries, deckJSONL, injectEido, toBase64 } from "../src/export.ts";
import type { SavedView } from "../src/schema.ts";
import { synthMap } from "../e2e/synth.ts";

test("save payload: the browser's exact byte path (fflate gzip ∘ encodeContainer) round-trips all three strata", () => {
  const D = synthMap();
  // WORK stratum: a view carrying a selection and a derived axis — full ids, no cap
  const view: SavedView = {
    name: "the beta clump", created: 1754700000000,
    state: {
      layout: "axes", channels: { color: "d0", x: "a", y: "b" }, grain: 3,
      derived: [{ label: "blobby", key: "d0", ids: Array.from({ length: 30 }, (_, i) => "d" + (30 + i)) }],
      selection: Array.from({ length: 60 }, (_, i) => "d" + i),
    },
  };
  D.views = [view];
  const bytes = gzipSync(encodeContainer(D));          // exactly what App.saveDoc writes/downloads
  const back = decodeContainer(gunzipSync(bytes));
  // source truth
  expect(back.ids).toEqual(D.ids);
  expect(back.titles).toEqual(D.titles);
  expect(back.cores).toEqual(D.cores);
  expect(back.notes[0]).toEqual(D.notes[0]);
  // caches
  expect(back.scores.a).toEqual(D.scores.a);
  expect(back.xy.length).toBe(D.ids.length);
  expect(back.cluster).toEqual(D.cluster);
  // work
  expect(back.views).toEqual([view]);
  expect(back.views![0].state.selection!.length).toBe(60);
  expect(back.views![0].state.derived![0].ids.length).toBe(30);
});

test("vault zip: the app's client-side zip carries one .md per card plus the manifest", () => {
  const D = synthMap();
  const { manifest, cards } = vaultEntries(D);
  const entries: Record<string, Uint8Array> = { [manifest.name]: strToU8(manifest.text) };
  for (const c of cards) entries[c.name] = strToU8(c.text);
  const back = unzipSync(zipSync(entries));
  const names = Object.keys(back);
  expect(names.length).toBe(D.ids.length + 1);                       // 90 cards + eidoscope-vault.json
  expect(names).toContain("eidoscope-vault.json");
  const man = JSON.parse(strFromU8(back["eidoscope-vault.json"]));
  expect(man.eidoscope).toBe("vault");
  expect(man.count).toBe(D.ids.length);
  const firstMd = strFromU8(back[cards[0].name]);
  expect(firstMd).toContain(`id: "${D.ids[0]}"`);                    // the same frontmatter the CLI sink writes
  expect(firstMd).toContain("axes:");
  expect(firstMd).toContain(D.cores[0].slice(0, 10));
});

test("deck JSONL: one card-shaped row per card, notes and exact scores riding along", () => {
  const D = synthMap();
  const lines = deckJSONL(D).trim().split("\n");
  expect(lines.length).toBe(D.ids.length);
  const r = JSON.parse(lines[3]);
  expect(r.id).toBe(D.ids[3]);
  expect(r.title).toBe(D.titles[3]);
  expect(r.core).toBe(D.cores[3]);
  expect(r.axes.a.score).toBe(D.scores.a[3]);
  expect(typeof r.axes.a.note).toBe("string");
});

test("injectEido: injects the payload before </head> and strips a payload the shell already carries", () => {
  const eido = new Uint8Array([1, 2, 3, 250]);
  const shell = "<html><head><title>x</title></head><body></body></html>";
  const one = injectEido(shell, eido);
  expect(one).toContain(`window.__EIDO_DATA__=${JSON.stringify(toBase64(eido))}`);
  expect(one.indexOf("__EIDO_DATA__")).toBeLessThan(one.indexOf("</head>"));
  // re-exporting FROM a single-file build must not stack two payloads
  const two = injectEido(one, new Uint8Array([9, 9]));
  expect(two.match(/__EIDO_DATA__/g)!.length).toBe(1);
  expect(two).toContain(JSON.stringify(toBase64(new Uint8Array([9, 9]))));
});
