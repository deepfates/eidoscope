// Verified slice: run deriveCard on ONE real fixture doc + the real discovered axes.
// Proves the gorm-via-Ax card works in-grain (typed output, notes aligned to axes).
// (Positions come from the PCA projection now, not the LLM — the card carries summary + per-axis notes.)
import { readFileSync, readdirSync } from "node:fs";
import { deriveCard } from "./signatures.ts";
import { provider } from "./provider.ts";

const FIX = process.env.EIDOSCOPE_FIXTURE ?? "";
const MD = process.env.EIDOSCOPE_FIXTURE_MD ?? "";

const axes = JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
const axesText = axes.map((a: any, i: number) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

// pick one substantial document from the fixture corpus
const pick = readdirSync(MD).filter(f => f.endsWith(".md")).map(f => ({ f, t: readFileSync(`${MD}/${f}`, "utf8") })).find(x => x.t.length > 5000)!;
const title = (pick.t.match(/^title:\s*"([^"]+)"/m) || [])[1] || pick.f;
const text = pick.t.split(/\n---\n/).slice(1).join("\n").replace(/\s+/g, " ").slice(0, 6000);

const llm = provider();

const card = await deriveCard.forward(llm, { documentTitle: title, documentBody: text, corpusAxes: axesText });

console.log("TITLE:", title, "\n");
console.log("CORE:", card.coreSummary, "\n");
axes.forEach((a: any, i: number) => console.log(`  ${a.name}  — ${card.axisNotes?.[i]}`));
const ok = Array.isArray(card.axisNotes) && card.axisNotes.length === axes.length && typeof card.coreSummary === "string";
console.log(ok ? `\n✅ card slice works — typed card, ${card.axisNotes.length} notes aligned to ${axes.length} axes` : "\n⚠ shape mismatch");
