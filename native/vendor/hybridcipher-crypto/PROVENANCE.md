# HybridCipher crypto source

Vendored from the HybridCipher `crypto` crate at Git revision
`38810069a84f5050b7d1e9798510c89311156ef6` (clean source tree).

The upstream package declares `MIT OR Apache-2.0`. Butler distributes this copy
under the Apache-2.0 alternative; the upstream license is in `LICENSE-APACHE`.
Source files are unchanged. The standalone Cargo manifest expands workspace
dependencies and removes development-only dependencies and benchmark targets.
No other HybridCipher client, server, account, or mount package is included.

Builds use Butler's checked-in Cargo.lock. Platform adapters in `butler-crypto`
do not use the upstream local key cache's plaintext compatibility fallback.
