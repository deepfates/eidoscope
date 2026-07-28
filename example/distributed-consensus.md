---
title: "Distributed Consensus and Raft"
date: "2025-02-03"
---
Getting a cluster of machines to agree on a single value, despite crashes and network delays, is the consensus problem. Paxos proved it possible but is famously hard to implement; Raft reframed the same guarantees around an understandable leader-election and log-replication model. A leader accepts writes, replicates them to followers, and commits once a majority acknowledge. The hard parts are all in the corners: split votes, stale leaders, and log divergence after a partition heals. Consensus underpins everything from etcd to distributed databases — it is the substrate that lets a group of unreliable computers behave like one reliable one.
