# Security Policy

Please do not publish security-sensitive reports in public issues.

To report a vulnerability, use GitHub private vulnerability reporting from the
repository's Security tab. Include a concise description, affected versions,
reproduction steps, and any relevant logs with secrets removed.

Code Butler stores project memory in a project-local `.code-butler/` directory.
Do not commit real `.code-butler/config.json`, `.code-butler/.env`, SQLite
database files, imported conversation logs, API keys, or other local memory
state to public repositories.

## Encrypted cloud sync

Reports about encrypted cloud sync are in scope: the TypeScript client under
`src/cloud/` and `src/secrets/`, the native helper under `native/`, and the
protocol in `docs/encrypted-sync-protocol.md`. That document lists what the
service can observe (opaque IDs, sizes, timing, public device labels) and what
is outside the protection of encryption, such as an approved device that is
compromised. Reports showing that the service, or anyone without an approved
device or the recovery kit, can read memory or secrets content are especially
welcome.

Released npm packages include prebuilt `butler-crypto` binaries under
`dist/native/<platform>/`, each with a `manifest.json` recording its SHA-256
and the `Cargo.lock` it was built from. They are built from this repository by
the public release workflow.
