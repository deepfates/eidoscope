// THE EXPORT SURFACE — every outbound flow, in one place (eid-sh90 factoring; feeds eid-ncrq).
//
// src/export.ts (host-free) decides what an export CONTAINS: the vault's markdown entries, the deck's
// JSONL, the shell injection. This module is its browser binding — it decides what an export is
// PACKAGED as and what the file is called, then hands bytes to viewer/src/file.ts to land on disk.
// The split matters because the contents are shared with the CLI while the packaging is browser-only.
//
// Why these left App.svelte: they are pure functions of (contract, base name) and touch no reactive
// state, so living in the component bought nothing and cost the component's merge surface — App.svelte
// took 134 commits in thirty days and eight explicit conflict resolutions, one of which
// (2d20a8c) was the document lifecycle colliding with ingest's front door. Everything here is now
// unit-testable without mounting a component, which it never was before.
//
// Every export flows FROM THE CARDS, which is the contract's own rule: the cards are the source truth
// and every outbound artefact is a view onto them.
import { gzipSync, zipSync, strToU8 } from "fflate";
import { injectEido, vaultEntries, deckJSONL } from "../../src/export";
import { encodeContainer } from "../../src/eido-container";
import type { MapContract } from "../../src/schema";

// The name every artefact is built from: the open document's filename with its extension dropped.
export const exportBase = (fileName: string): string => fileName.replace(/\.eido$/i, "") || "eidoscope";

// A named blob ready to land: what to write, what to call it, what it is. Returning this instead of
// calling download() directly is what makes each export testable — the test asserts the bytes and the
// filename, and only the caller touches the DOM.
export type Artifact = { data: Uint8Array | string; name: string; type: string };

/** The document itself: the whole contract through the shared codec, gzipped. What Save writes. */
export const eidoBytes = (D: MapContract): Uint8Array => gzipSync(encodeContainer(D));

/** Export → single file: this very app with the document baked in, openable by someone with no app. */
export function htmlArtifact(D: MapContract, base: string, shell: string): Artifact {
  return { data: injectEido(shell, eidoBytes(D)), name: base + ".html", type: "text/html" };
}

/** Export → vault: a folder of markdown cards (+ manifest), zipped. The re-ingestable round trip. */
export function vaultArtifact(D: MapContract, base: string): Artifact {
  const { manifest, cards } = vaultEntries(D);
  const entries: Record<string, Uint8Array> = { [manifest.name]: strToU8(manifest.text) };
  for (const c of cards) entries[c.name] = strToU8(c.text);
  return { data: zipSync(entries), name: base + "-vault.zip", type: "application/zip" };
}

/** Export → deck: one JSON object per card, for anything that reads a stream of records. */
export function deckArtifact(D: MapContract, base: string): Artifact {
  return { data: deckJSONL(D), name: base + "-deck.jsonl", type: "application/x-ndjson" };
}

/** Export → selection: the held set as {ids,titles,urls}, the shape the CLI descend verb reads.
 *  Data-out only — the old selection-pane FERRY died when descend became an in-page gesture. */
export function selectionArtifact(D: MapContract, base: string, selection: number[]): Artifact | null {
  if (!selection.length) return null;
  const payload = {
    ids: selection.map((i) => D.ids[i]),
    titles: selection.map((i) => D.titles[i]),
    urls: selection.map((i) => D.urls?.[i]),
  };
  return { data: JSON.stringify(payload, null, 2), name: `${base}-selection-${payload.ids.length}.json`, type: "application/json" };
}

// The shell for a single-file export is THIS app: fetched from the host when served, and the live
// document as the file:// fallback (where fetch of the page path won't work). Kept here rather than in
// htmlArtifact so the artifact function stays pure and testable.
export async function appShell(fetchImpl: typeof fetch = fetch, pathname = location.pathname): Promise<string> {
  try { const r = await fetchImpl(pathname); if (r.ok) return await r.text(); } catch {}
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}
