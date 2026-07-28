---
title: "What Type Systems Actually Buy You"
date: "2025-02-14"
---
A type system is a lightweight formal method you run on every save. It partitions programs into those it can prove free of certain errors and those it rejects. Richer systems — sum types, generics, linear and dependent types — let you encode more invariants in types, pushing whole classes of bug from runtime to compile time. The cost is expressiveness friction and the occasional false rejection of a correct program. The deep idea, via Curry–Howard, is that types are propositions and programs are proofs: to typecheck is to check a proof. Most working value sits well short of dependent types, but the direction is the point.
