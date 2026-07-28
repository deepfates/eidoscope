import { readFileSync } from "node:fs";
import { getTextEmbeddings } from "./src/embed.ts";
import { findOptimalK, clusterEmbeddings } from "./src/cluster.ts";
import { CFG } from "./src/config.ts";

// GOLD-MATCH: prove the decoupled modules reproduce curare's ACTUAL output, not just "run".
// Requires the curare checkout (the very thing we're decoupling from) — dev-only verification.
// If new embeddings ~= curare embeddings and new clusters == curare clusters, the port is faithful.

const curare: any = await import(process.env.GOLDMATCH_CURARE ?? "/Users/deepfates/Hacking/github/deepfates/curare/dist/index.js");
const FIX = "/Users/deepfates/Hacking/readwise/triangulation/runs/main";
const cards = JSON.parse(readFileSync(`${FIX}/cards2.json`, "utf8"));
const CE = JSON.parse(readFileSync(`${FIX}/card-embs.json`, "utf8"));
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const unit = (v: number[]) => { let n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n); };

// ---- 1. EMBEDDING equivalence (new transformers.js call vs curare's) ----
const texts = (Object.values(cards) as any[]).map((c) => c.core).filter(Boolean).slice(0, 30);
const items = texts.map((t: string, i: number) => ({ id: `t${i}`, text: t }));
const mine = await getTextEmbeddings(items);
const gold = await curare.getTextEmbeddings(items, { model: CFG.embedModel });
let cosSum = 0, worst = 1;
for (let i = 0; i < mine.length; i++) { const c = dot(unit(mine[i]), unit(gold[i])); cosSum += c; worst = Math.min(worst, c); }
const meanCos = cosSum / mine.length;
console.log(`\n1. EMBEDDING  (${mine.length} texts)`);
console.log(`   mean cosine(new, curare) = ${meanCos.toFixed(6)}   worst = ${worst.toFixed(6)}   dim ${mine[0].length} vs ${gold[0].length}`);

// ---- 2. CLUSTERING equivalence on real card embeddings (same seed, same method) ----
const X: number[][] = CE.embs.slice(0, 300);
const kMax = Math.max(2, Math.min(60, Math.floor(X.length / 4)));
const myK = findOptimalK(X, kMax), goldK = curare.findOptimalK(X, kMax);
const myC = clusterEmbeddings(X, myK).clusters;
const goldC = curare.clusterEmbeddings(X, goldK).clusters;
let same = 0; for (let i = 0; i < myC.length; i++) if (myC[i] === goldC[i]) same++;
console.log(`\n2. CLUSTERING  (${X.length} card vectors)`);
console.log(`   findOptimalK: new=${myK}  curare=${goldK}`);
console.log(`   cluster-assignment identical: ${same}/${myC.length} (${(100 * same / myC.length).toFixed(1)}%)`);

// ---- verdict ----
const embOk = meanCos > 0.999 && worst > 0.999;
const clOk = myK === goldK && same === myC.length;
console.log(`\n${embOk ? "✅" : "❌"} embeddings match curare (mean cos ${meanCos.toFixed(4)})`);
console.log(`${clOk ? "✅" : "⚠"} clustering ${clOk ? "byte-identical to curare" : `differs (k ${myK} vs ${goldK}, ${same}/${myC.length} same)`}`);
console.log(embOk && clOk ? "\n🟢 DECOUPLING IS FAITHFUL — the direct libs reproduce curare's gold output." : "\n🟠 inspect the mismatch before trusting the port.");
