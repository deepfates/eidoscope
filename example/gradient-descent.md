---
title: "Gradient Descent, Intuitively"
date: "2025-03-01"
---
Almost all of modern machine learning is one idea repeated: define how wrong you are (a loss), compute which direction reduces it fastest (the gradient), take a small step that way, repeat. Backpropagation is just the chain rule applied efficiently across a deep network so every parameter gets its share of the blame. The subtleties are practical — learning rates, momentum, adaptive methods like Adam, and the strange fact that hugely overparameterized models find good minima anyway. It is a dumb, local, greedy procedure that, at scale and with the right architecture, produces systems that translate languages and fold proteins.
