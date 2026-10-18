# Butler native security helper

This helper uses the vendored HybridCipher crypto package recorded in
`../vendor/hybridcipher-crypto/PROVENANCE.md`. Building does not require a sibling
checkout. Run `npm run build:crypto` for development and `npm run package:crypto`
after the JS build for a release artifact.

One bounded JSON request arrives on stdin and one response leaves on stdout. No
keys appear in argv or diagnostics. Private device, project and recovery keys stay
in Rust; the TypeScript API passes opaque IDs and epochs. Requests are limited to
32 MiB and encryption batches to 128 objects. The helper has no network access.

A per-user Windows DPAPI blob or macOS Keychain item protects a random wrapping
key. That key encrypts `state.enc` using ChaCha20-Poly1305. Setup requires secure
storage readback. There is no plaintext fallback; Linux enrollment fails locked.
An OS file lock serializes helper state access. State writes use fsync, atomic
rename and readback. A missing wrapping key never silently replaces an existing
security-state key.

Signed, parent-linked vault records govern enrollment, project epochs and recovery
packages. Normal devices retain recovery public keys and the encrypted kit only
once its export is confirmed. Recovery temporarily loads the offline authority to
complete a journaled membership/key cutover, then discards it.

