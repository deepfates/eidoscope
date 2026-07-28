---
title: "The CAP Theorem, Deflated"
date: "2025-04-28"
---
The CAP theorem says that when the network partitions, a distributed system must choose between staying consistent (refusing to answer) and staying available (answering possibly-stale data). It is true but often overstated: partitions are rare, so the real daily tradeoff is between latency and consistency, which the PACELC framing captures better. What matters in practice is picking the consistency model deliberately — linearizable, causal, eventual — per operation, rather than treating CAP as a religious three-way choice. Most systems are consistent when they can be and available when they must be.
