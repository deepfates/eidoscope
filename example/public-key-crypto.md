---
title: "Public-Key Cryptography"
date: "2025-03-20"
---
Symmetric encryption needs both parties to already share a secret — a chicken-and-egg problem for strangers on an open network. Public-key cryptography breaks it: a keypair where anything encrypted with the public half can only be undone with the private half. From this one asymmetry we build key exchange, digital signatures, and the certificate chains that make HTTPS trustworthy. The security rests on problems believed hard — factoring, discrete logs, elliptic curves — which is why quantum computers, if they scale, threaten it and post-quantum schemes are being standardized now. It is math as infrastructure.
