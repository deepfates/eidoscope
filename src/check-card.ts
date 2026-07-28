// Verified slice: run deriveCard on ONE real fixture doc + the real discovered axes.
// Proves the gorm-via-Ax card works in-grain (typed output, scores aligned to axes).
import { readFileSync, readdirSync } from "node:fs";
import { ai } from "@ax-llm/ax";
import { deriveCard } from "./signatures.ts";

const FIX = "/Users/deepfates/Hacking/readwise/triangulation/runs/main";
const MD = "/Users/deepfates/Hacking/readwise/markdown-export";
const KEY = (readFileSync("/Users/deepfates/Hacking/github/deepfates/curare/.env", "utf8").match(/OPENROUTER_API_KEY=(.+)/) || [])[1].trim();

const axes = JSON.parse(readFileSync(`${FIX}/axes-schema.json`, "utf8")).axes;
const axesText = axes.map((a: any, i: number) => `${i + 1}. ${a.name}: low="${a.pole_low}" high="${a.pole_high}"`).join("\n");

// pick one substantial document from the fixture corpus
const pick = readdirSync(MD).filter(f => f.endsWith(".md")).map(f => ({ f, t: readFileSync(`${MD}/${f}`, "utf8") })).find(x => x.t.length > 5000)!;
const title = (pick.t.match(/^title:\s*"([^"]+)"/m) || [])[1] || pick.f;
const text = pick.t.split(/\n---\n/).slice(1).join("\n").replace(/\s+/g, " ").slice(0, 6000);

const llm = ai({ name: "openai", apiKey: KEY, apiURL: "https://openrouter.ai/api/v1", config: { model: "google/gemini-3-flash-preview" } } as any);

const card = await deriveCard.forward(llm, { documentTitle: title, documentBody: text, corpusAxes: axesText });

console.log("TITLE:", title, "\n");
console.log("CORE:", card.coreSummary, "\n");
axes.forEach((a: any, i: number) => console.log(`  ${String(card.axisScores?.[i]).padStart(3)}  ${a.name}  — ${card.axisNotes?.[i]}`));
const ok = Array.isArray(card.axisScores) && card.axisScores.length === axes.length && typeof card.coreSummary === "string";
console.log(ok ? `\n✅ card slice works — typed card, ${card.axisScores.length} scores aligned to ${axes.length} axes` : "\n⚠ shape mismatch");
