// CLI honesty: a stranger deserves one honest line naming the problem; a failure never wears a ✅;
// no raw stack traces for foreseeable errors. These spawn the real CLI on broken inputs and assert
// exit codes + clean stderr. None of them spend an LLM call.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cardCorpus } from "../src/card.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");
const EIDO = join(ROOT, "test/fixtures/example.eido");

// env with a fake key (so preflight passes and we test the later guard) or with no key at all
const envWith = (extra: Record<string, string> = {}, dropKeys = false) => {
  const env: Record<string, string> = { ...process.env } as any;
  if (dropKeys) for (const k of ["OPENROUTER_API_KEY", "EIDOSCOPE_API_KEY", "EIDOSCOPE_API_URL"]) delete env[k];
  return { ...env, ...extra };
};

async function cli(args: string[], env = envWith({ OPENROUTER_API_KEY: "test-key" })) {
  // --env-file=/dev/null: the repo's own .env (real key) must not leak into spawns that test keyless
  // behavior — bun auto-loads .env from cwd otherwise, and these tests then pass only in worktrees.
  const p = Bun.spawn(["bun", "--env-file=/dev/null", CLI, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const noStack = (err: string) => { expect(err).not.toContain("    at "); expect(err).not.toContain("error: Uncaught"); };

test("no args → usage to stderr, exit 1", async () => {
  const r = await cli([]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: eidoscope <folder>");
});

test("--help → usage to stdout, exit 0, and it tells the truth about verbs + flags", async () => {
  const r = await cli(["--help"]);
  expect(r.code).toBe(0);
  for (const s of ["example", "export <map.eido>", "descend <parent.eido> <selection.json>", "--relabel", "--fixture",
    "--limit", "--min-chars", "--frontier", "--embed raw", "--out", "--name", "--debug-json",
    "OPENROUTER_API_KEY", "EIDOSCOPE_API_KEY", "EIDOSCOPE_API_URL"]) expect(r.out).toContain(s);
});

test("missing API key → one line naming the real env vars, before any loading/embedding", async () => {
  const r = await cli(["example"], envWith({}, true));
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("no API key: set OPENROUTER_API_KEY or EIDOSCOPE_API_KEY (or point EIDOSCOPE_API_URL at a local OpenAI-compatible server)");
  expect(r.err).not.toContain("embedding");   // preflight fired before the corpus was touched
});

test("nonexistent corpus folder → one line, exit 1, no stack", async () => {
  const r = await cli(["does-not-exist-xyz"]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("no such folder: does-not-exist-xyz");
  noStack(r.err);
});

test("export with missing args → usage to stderr, exit 1", async () => {
  const r = await cli(["export"]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("usage: eidoscope export <map.eido> [--as vault|deck|html] [--out <dir>]");
});

test("descend with missing args → usage to stderr, exit 1", async () => {
  const r = await cli(["descend"]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("usage: eidoscope descend <parent.eido> <selection.json> [--out <dir>] [--name <title>]");
});

test("export nonexistent map → one line, exit 1", async () => {
  const r = await cli(["export", "nope.eido"]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("no such file: nope.eido");
  noStack(r.err);
});

test("export a truncated/non-gzip .eido → 'not a valid .eido' line, exit 1, no stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cli-"));
  const bad = join(dir, "bad.eido");
  writeFileSync(bad, "this is not gzip at all");
  const r = await cli(["export", bad]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe(`not a valid .eido (corrupt or not this format): ${bad}`);
  noStack(r.err);
});

test("descend with garbage selection JSON → one line, exit 1, no stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cli-"));
  const sel = join(dir, "sel.json");
  writeFileSync(sel, "{not json!!");
  const r = await cli(["descend", EIDO, sel]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe(`${sel} is not valid JSON (expected the viewer's selection export)`);
  noStack(r.err);
});

test("descend with foreign-corpus ids → the guard's own message, without the throw dressing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cli-"));
  const sel = join(dir, "sel.json");
  writeFileSync(sel, JSON.stringify({ ids: ["not-a-real-id-1", "not-a-real-id-2"] }));
  const r = await cli(["descend", EIDO, sel]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("descend: 2 selection id(s) not in the parent map (e.g. not-a-real-id-1)");
  noStack(r.err);
});

test("binary bytes wearing .md are skipped with a one-line warning, never carded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-cli-"));
  const bin = join(dir, "sneaky.md");
  writeFileSync(bin, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));  // png-ish garbage incl. nulls
  const r = await cli([dir]);
  expect(r.code).toBe(1);   // only doc was binary → nothing to map, honestly reported
  expect(r.err).toContain(`⚠ skipped binary-looking file (not text): ${bin}`);
  expect(r.err).toContain("no documents found");
  noStack(r.err);
});

test("--relabel on a dir with no map → one line, exit 1", async () => {
  const r = await cli(["--relabel", "src"]);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe("no .eido (or map-data.json) found in src");
});

// cardCorpus guards, called directly (no spawn, no network): a run where every card fails must throw,
// and an auth error must abort immediately with the provider's own words.
const AXES: any[] = [{ key: "a1", name: "A", pole_low: "lo", pole_high: "hi", pc: 0, var: 0.5 }];
const DOCS = [{ id: "d1", title: "T1", body: "b".repeat(300) }, { id: "d2", title: "T2", body: "c".repeat(300) }];

test("cardCorpus: every card failing throws with the underlying error, never returns an empty deck", async () => {
  const sig = { forward: async () => ({}) };   // model "succeeds" but returns nothing usable
  await expect(cardCorpus(DOCS as any, AXES, { llm: {}, sig, concurrency: 2 })).rejects.toThrow(/every card failed \(2 docs, 0 cards\)/);
});

test("cardCorpus: a 401 aborts at once with the provider's message", async () => {
  const sig = { forward: async () => { throw Object.assign(new Error("401 Unauthorized: No auth credentials found"), { status: 401 }); } };
  await expect(cardCorpus(DOCS as any, AXES, { llm: {}, sig, concurrency: 2 })).rejects.toThrow(/the provider rejected the API key — 401 Unauthorized/);
});
