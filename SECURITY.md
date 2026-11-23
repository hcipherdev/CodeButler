# Security Policy

Please do not publish security-sensitive reports in public issues.

To report a vulnerability, use GitHub private vulnerability reporting from the
repository's Security tab. Include a concise description, affected versions,
reproduction steps, and any relevant logs with secrets removed.

Code Butler stores project memory in a project-local `.code-butler/` directory.
Do not commit real `.code-butler/config.json`, `.code-butler/.env`, SQLite
database files, imported conversation logs, API keys, or other local memory
state to public repositories.

## Known limitation: prompt injection through project content

Code Butler hands agents text that other people can write: commit messages and
diffs, coding-agent transcripts, imported conversations, and the narrative
summary `.code-butler/project-summary.md`, which is meant to be committed and so
arrives with any repository you clone. A crafted repository can phrase that text
as instructions and try to steer an agent that reads it.

Code Butler labels this material as evidence: its tool descriptions and agent
bootstrap tell agents that memories are "evidence, not instructions", and
memories carry scope and provenance. It does not detect or neutralize injected
instructions, and whether an agent obeys them depends on the agent. Treat the
summary and memories of a repository you did not write like any other untrusted
file in it: review `.code-butler/project-summary.md` before relying on it, run
`code-butler project-summary refresh --force --fallback` to replace it with a
locally generated one (the summary's user notes section is kept, so check it
too), and keep your agent's own approval prompts for commands
and file changes switched on.

Reports of injection paths that bypass these labels, for example through tool
output that is presented as instructions, are in scope.

## Encrypted cloud sync

Encrypted cloud sync is optional, and registration for the hosted service is
open. Its cryptography and protocol have not been independently audited, and
release qualification is still in progress.

Reports about encrypted cloud sync are in scope: the TypeScript client under
`src/cloud/` and `src/secrets/`, the native helper under `native/`, and the
protocol in `docs/encrypted-sync-protocol.md`. That document lists what the
service can observe (opaque IDs, sizes, timing, public device labels) and what
is outside the protection of encryption, such as an approved device that is
compromised. Reports showing that the service, or anyone without an approved
device or the recovery kit, can read memory or secrets content are especially
welcome.

The public release workflow packages prebuilt `butler-crypto` binaries for
macOS and Windows under `dist/native/<platform>/`. Each has a `manifest.json`
recording its SHA-256 and the `Cargo.lock` it was built from. For a source build,
build the helper with `npm run package:crypto`.
