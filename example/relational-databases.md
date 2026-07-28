---
title: "Why Relational Databases Won"
date: "2025-03-12"
---
The relational model separates what data means from how it is stored. You declare tables and constraints; the query planner figures out the access paths. Add ACID transactions and you get a system where concurrent users never see each other's half-finished work, and a crash never leaves a torn write. Decades of NoSQL alternatives traded these guarantees for scale, then slowly reinvented them (transactions, secondary indexes, SQL dialects) once teams remembered why they existed. The relational database is boring in the best sense: a well-understood, decades-hardened tool that quietly refuses to lose your data.
