---
title: "What Optimizing Compilers Do"
date: "2025-05-19"
---
Between the code you write and the instructions that run, an optimizing compiler performs dozens of semantics-preserving rewrites: inlining, constant folding, dead-code elimination, loop unrolling, vectorization, register allocation. Each is a small local truth about equivalent programs; together they can make naive source run an order of magnitude faster. The constraint is that every transformation must preserve observable behavior, which is why undefined behavior is so load-bearing and so dangerous — it is the slack the compiler exploits. Modern backends like LLVM turn this into a reusable pipeline any language can target.
