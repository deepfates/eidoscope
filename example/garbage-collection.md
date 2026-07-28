---
title: "Garbage Collection Tradeoffs"
date: "2025-04-15"
---
Manual memory management is fast and precise and a bottomless source of security bugs. Garbage collection trades some throughput and predictability for the promise that use-after-free and double-free simply cannot happen. The techniques form a design space: reference counting is simple but leaks cycles; tracing collectors pause to walk the live object graph; generational and concurrent collectors shrink those pauses at the cost of complexity. Rust's borrow checker is the interesting third path — memory safety proven at compile time with no runtime collector at all, paying in programmer effort instead of CPU.
