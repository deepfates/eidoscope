// Shared LLM plumbing for the gorm layer: a content-addressed cache, a concurrency pool, and a retry
// wrapper. Every stage that spends model calls at scale (carding, region naming) uses THESE, so the
// caching discipline and the "retry, never silently drop" discipline are defined once, not re-invented.
//
// HOST-FREE (eid-bacg): this module runs identically in Bun and in the browser page. Persistence is an
// injected adapter — the node side passes a file adapter (src/config.ts fileStore), the page passes
// nothing and gets a session-memory cache (which is exactly what makes an in-page carding pass
// resumable within the session: a retry reloads every card that already succeeded).

// djb2 — stable across runs and processes (unlike a random seed), so a content key computed today
// matches the same content tomorrow. Used to build cache keys from the exact inputs of a call.
export const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

// How a Store persists: read the whole log once at construction, append one line per put. The node
// adapter appends to a .jsonl file (crash-safe); absent, entries live only in memory.
export type StorePersist = { read(): string | undefined; append(line: string): void };

// Content-addressed, crash-safe cache: one {k,v} JSON per line, appended as results arrive. An entry
// hits whenever its inputs hash the same, so re-running a corpus reloads instead of re-spending calls.
export class Store {
  private map = new Map<string, any>();
  constructor(private persist?: StorePersist) {
    const raw = persist?.read();
    if (raw) for (const l of raw.split("\n")) { if (!l) continue; try { const { k, v } = JSON.parse(l); this.map.set(k, v); } catch {} }
  }
  has(k: string) { return this.map.has(k); }
  get(k: string) { return this.map.get(k); }
  put(k: string, v: any) { this.map.set(k, v); this.persist?.append(JSON.stringify({ k, v }) + "\n"); }
}

// Bounded-concurrency map: run `fn` over `items` with at most `conc` in flight at once.
export async function pool<T>(items: T[], fn: (t: T) => Promise<void>, conc: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, conc) }, async () => { while (i < items.length) { const j = i++; await fn(items[j]); } }));
}

// An auth failure (bad/missing key) is not transient: retrying it burns time and every call will fail
// the same way. Detected from the status code when the error carries one, else from the message text.
export const isAuthError = (e: any): boolean => {
  const s = e?.status ?? e?.response?.status ?? e?.cause?.status;
  if (s === 401 || s === 403) return true;
  return /\b401\b|\b403\b|unauthorized|authentication failed|invalid[_ ]?api[_ ]?key|no auth credentials|incorrect api key/i.test(String(e?.message ?? e));
};

// One readable line from a provider error — first line of the message, bounded, no stack dressing.
export const errLine = (e: any): string => String(e?.message ?? e).split("\n")[0].trim().slice(0, 300);

// Retry transient LLM failures (rate limits, network) with exponential backoff + jitter, honoring
// Retry-After when the error exposes it. Returns undefined ONLY after retries are exhausted — the caller
// counts that as a real, reported failure, never a silent drop. `onFail` receives the final error so the
// caller can surface WHY (e.g. the 401 text) instead of just counting; auth errors skip the retries.
export async function withRetry<T>(fn: () => Promise<T>, retries = 4, onFail?: (e: any) => void): Promise<T | undefined> {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e: any) {
      if (a >= retries || isAuthError(e)) { onFail?.(e); return undefined; }
      const ra = Number(e?.retryAfter ?? e?.response?.headers?.["retry-after"] ?? e?.headers?.["retry-after"]);
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 400 * 2 ** a) + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
