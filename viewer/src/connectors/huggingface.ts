// HUGGINGFACE DATASET CONNECTOR (eid-ilc5) — the second connector through the seam (./types.ts).
// Talks to the public datasets-server API (https://huggingface.co/docs/datasets-server): auth-free
// for public datasets, and CORS-open from browsers (verified 2026-08-09: OPTIONS preflight answers
// access-control-allow-origin echoing the origin; GET /rows likewise). Flow: parse an id or URL →
// /splits picks a config+split → /first-rows offers the columns → /rows pages the whole split
// (100/page, the server's num_rows_per_page) into IngestFile[]. Corpus rules — the 200-char floor,
// dedupe, splitOversized, the in-page envelope — are NOT re-implemented here: they come free from
// corpus-core/IngestRun, exactly like the folder connector.
// IngestFile's home module (run.ts) — importing it via ../ingest would drag the engine-client's
// `?worker&inline` import into the root tsc pass (include=[src,test] → test/hf-connector.test.ts →
// here), which only the viewer tsconfig's vite-env types can resolve.
import type { IngestFile } from "../run";
import type { CorpusPayload } from "./types";

export const HF_API = "https://datasets-server.huggingface.co";

// "user/dataset", "dataset" (canonical), or any huggingface.co/datasets/... URL → the dataset id.
export function parseDatasetId(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  const url = s.match(/huggingface\.co\/datasets\/([\w.-]+(?:\/[\w.-]+)?)/i);
  if (url) return url[1];
  if (/^[\w.-]+(?:\/[\w.-]+)?$/.test(s) && s.length) return s;
  return null;
}

async function getJSON(path: string): Promise<any> {
  const r = await fetch(HF_API + path);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export type HFColumn = { name: string; isString: boolean };
export type HFPreview = {
  dataset: string; config: string; split: string;
  columns: HFColumn[];
  textColumns: string[];        // string-typed columns — the candidates for "which column is the text"
  idColumn?: string;            // a string column named id/title/name, used for row titles when present
  sample: Record<string, unknown>[];
  numRowsTotal: number;
  rowsPerPage: number;
};

// One preview call chain: /splits → /first-rows (columns + sample) → /rows length=1 (honest total).
export async function previewDataset(input: string): Promise<HFPreview> {
  const dataset = parseDatasetId(input);
  if (!dataset) throw new Error(`"${input.trim()}" doesn't look like a dataset id — paste "user/dataset" or a huggingface.co/datasets URL`);
  const splits = await getJSON(`/splits?dataset=${encodeURIComponent(dataset)}`);
  const all: { config: string; split: string }[] = splits?.splits ?? [];
  if (!all.length) throw new Error(`no splits found for ${dataset}`);
  const s = all.find((x) => x.split === "train") ?? all[0];
  const q = `dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(s.config)}&split=${encodeURIComponent(s.split)}`;
  const [first, page] = await Promise.all([
    getJSON(`/first-rows?${q}`),
    getJSON(`/rows?${q}&offset=0&length=1`),
  ]);
  const columns: HFColumn[] = (first?.features ?? []).map((f: any) => ({ name: f.name, isString: f?.type?._type === "Value" && /string/.test(f?.type?.dtype ?? "") }));
  const textColumns = columns.filter((c) => c.isString).map((c) => c.name);
  if (!textColumns.length) throw new Error(`${dataset} (${s.config}/${s.split}) has no string columns — nothing to read as text`);
  const idColumn = textColumns.find((n) => /^(id|title|name)$/i.test(n));
  return {
    dataset, config: s.config, split: s.split,
    columns, textColumns, idColumn,
    sample: (first?.rows ?? []).slice(0, 3).map((r: any) => r.row),
    numRowsTotal: page?.num_rows_total ?? 0,
    rowsPerPage: page?.num_rows_per_page ?? 100,
  };
}

const yamlSafe = (s: string) => s.replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

// Pure mapping: rows → IngestFile[]. Title from the id column when present, else "<dataset> · row N";
// frontmatter carries id + title so parseSourceFile keeps them without polluting the body text.
export function rowsToFiles(p: Pick<HFPreview, "dataset" | "config" | "split" | "idColumn">, rows: { row_idx: number; row: Record<string, unknown> }[], column: string): IngestFile[] {
  return rows.map((r) => {
    const text = String(r.row?.[column] ?? "");
    const rawTitle = p.idColumn ? String(r.row?.[p.idColumn] ?? "") : "";
    const title = yamlSafe(rawTitle) || `${p.dataset} · row ${r.row_idx}`;
    const name = `row-${r.row_idx}.md`;
    return {
      path: `hf://${p.dataset}/${p.config}/${p.split}/${name}`,
      name,
      text: `---\nid: hf-${r.row_idx}\ntitle: "${title}"\n---\n${text}\n`,
    };
  });
}

// Page the whole split lazily — no arbitrary row cap; the caller shows honest count-based progress
// and the envelope (IngestRun) says what in-page can hold. AbortSignal cancels cleanly mid-fetch.
export async function fetchDataset(
  p: HFPreview, column: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<CorpusPayload> {
  const files: IngestFile[] = [];
  const total = p.numRowsTotal;
  const page = Math.max(1, p.rowsPerPage);
  for (let offset = 0; offset < total; offset += page) {
    signal?.throwIfAborted();
    const q = `dataset=${encodeURIComponent(p.dataset)}&config=${encodeURIComponent(p.config)}&split=${encodeURIComponent(p.split)}&offset=${offset}&length=${Math.min(page, total - offset)}`;
    const j = await getJSON(`/rows?${q}`);
    files.push(...rowsToFiles(p, j?.rows ?? [], column));
    onProgress?.(files.length, total);
  }
  return {
    files,
    name: p.dataset,
    source: `huggingface:${p.dataset} (${p.config}/${p.split}) · column "${column}" · ${files.length} rows`,
  };
}
