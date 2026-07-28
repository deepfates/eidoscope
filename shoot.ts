// Repeatable visual verification: drive the rendered viewer in headless Chromium and screenshot
// each state to disk. Run: bun run shoot.ts [htmlfile]
import { chromium } from "playwright";

const file = process.argv[2] ?? "eidoscope-fixture.html";
const url = "file://" + process.cwd() + "/" + file;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url);
await p.waitForTimeout(1800); // let canvas + umap settle

await p.screenshot({ path: "shot-1-map.png" });

await p.click("#deckbtn"); await p.waitForTimeout(500);
await p.screenshot({ path: "shot-2-deck.png" });

// sort the deck by the first axis -> readable spectrum
const firstAxis = await p.$eval("#dsort", (s: any) => { s.selectedIndex = 1; s.dispatchEvent(new Event("change")); return s.value; });
await p.waitForTimeout(400);
await p.screenshot({ path: "shot-3-deck-by-axis.png" });

await p.click("#deckbtn"); // close deck
await p.$eval("#layout", (s: any) => { s.value = "axes"; s.dispatchEvent(new Event("change")); });
await p.waitForTimeout(1400);
await p.screenshot({ path: "shot-4-axis-scatter.png" });

await b.close();
console.log("shots written; sorted deck by:", firstAxis, "| page errors:", errs.length ? errs : "none");
