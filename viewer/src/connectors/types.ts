// THE CONNECTOR SEAM (eid-ilc5). A connector is anything that yields a corpus: it produces ONE
// CorpusPayload — already-read text files plus a name and a provenance line — and hands it to the
// same IngestRun every corpus goes through. The folder picker / drag-a-folder (viewer/src/ingest.ts
// filesFromFileList / filesFromDataTransfer) is the first connector; HuggingFace datasets
// (./huggingface.ts) is the second. A third (a URL scraper, an RSS feed, a Zotero library…) is a
// module that exports "something → Promise<CorpusPayload>" and a small UI to gather its inputs —
// nothing downstream changes: corpus rules (the 200-char floor, dedupe, the envelope) live in
// corpus-core/IngestRun and come free.
import type { IngestFile } from "../ingest";

export type CorpusPayload = {
  files: IngestFile[];   // already-read text files, ready for docsFromFiles
  name: string;          // the map's working name
  source: string;        // provenance.source — where this corpus truthfully came from
};
