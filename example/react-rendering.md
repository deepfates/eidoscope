---
title: "How React Rendering Works"
date: "2025-05-06"
---
React's core trick is declarative UI: you describe what the screen should look like for a given state, and React figures out the DOM mutations to get there. It builds a virtual tree, diffs it against the previous one, and applies the minimal set of changes. The mental model breaks down at the edges — effects, stale closures, unnecessary re-renders — which is why so much React tooling is about controlling when components recompute. The deeper lesson is that a fast enough diff makes "just re-render everything" a viable and much simpler programming model than manual DOM surgery.
