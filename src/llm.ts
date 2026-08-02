import { appendFileSync, readFileSync, existsSync } from "node:fs";

// Shared LLM plumbing for the gorm layer: a content-addressed cache, a concurrency pool, and a retry
// wrapper. Every stage that spends model calls at scale (carding, region naming) uses THESE, so the
// caching discipline and the "retry, never silently drop" discipline are defined once, not re-invented.

// djb2 — stable across runs and processes (unlike a random seed), so a content key computed today
// matches the same content tomorrow. Used to build cache keys from the exact inputs of a call.
export const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

// Content-addressed, crash-safe cache: one {k,v} JSON per line, appended as results arrive. An entry
// hits whenever its inputs hash the same, so re-running a corpus reloads instead of re-spending calls.
export class Store {
  private map = new Map<string, any>();
  constructor(private file?: string) {
    if (file && existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n")) { if (!l) continue; try { const { k, v } = JSON.parse(l); this.map.set(k, v); } catch {} }
  }
  has(k: string) { return this.map.has(k); }
  get(k: string) { return this.map.get(k); }
  put(k: string, v: any) { this.map.set(k, v); if (this.file) appendFileSync(this.file, JSON.stringify({ k, v }) + "\n"); }
}

// Bounded-concurrency map: run `fn` over `items` with at most `conc` in flight at once.
export async function pool<T>(items: T[], fn: (t: T) => Promise<void>, conc: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, conc) }, async () => { while (i < items.length) { const j = i++; await fn(items[j]); } }));
}

// Retry transient LLM failures (rate limits, network) with exponential backoff + jitter, honoring
// Retry-After when the error exposes it. Returns undefined ONLY after retries are exhausted — the caller
// counts that as a real, reported failure, never a silent drop.
export async function withRetry<T>(fn: () => Promise<T>, retries = 4): Promise<T | undefined> {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e: any) {
      if (a >= retries) return undefined;
      const ra = Number(e?.retryAfter ?? e?.response?.headers?.["retry-after"] ?? e?.headers?.["retry-after"]);
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 400 * 2 ** a) + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
