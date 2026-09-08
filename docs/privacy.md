# Privacy

Code Butler is local-first. Full-text search works offline, embeddings are optional, and destructive privacy administration is available only through the CLI.

## Storage redaction

New source content, chunks, memories, decisions, failures, JSON values, file paths, and temporary context pass through the same redaction policy before storage. Built-in rules cover common API keys, bearer tokens, AWS credentials, private keys, credential URLs, and major provider token formats.

Project-specific rules can be added in `.code-butler/config.json`:

```json
{
  "privacy": {
    "allowRemoteEmbeddings": false,
    "redactionPatterns": [
      {
        "name": "internal token",
        "kind": "regex",
        "pattern": "INTERNAL-[A-Za-z0-9]+"
      }
    ]
  }
}
```

Unsafe regular expressions are rejected when configuration loads. Code Butler never offers an unredacted remote-embedding mode.

## Administrative commands

```bash
code-butler privacy audit --json
code-butler privacy export --output ./memory-export.json
code-butler privacy import --input ./memory-export.json
code-butler privacy scrub
code-butler privacy delete --source-id <id> --confirm-delete <id>
code-butler privacy prune --dry-run
code-butler privacy prune --apply
```

Exports are redacted by default. A raw JSON export requires both `--raw` and `--confirm-raw-export`; raw export and destructive privacy commands are intentionally unavailable through MCP.

Scrub, confirmed non-empty import, delete, and applied retention pruning use verified SQLite recovery backups. They verify `quick_check` and foreign keys, retain the exact backup on failure, and remove the temporary recovery copy only after success. Use `--purge-backups` after scrub, delete, or prune when older database backups may still contain content you explicitly removed.

The operation log records migrations, lifecycle changes, redaction, deletion, export/import, pruning, and recovery using generated identifiers, hashes, categories, and counts. It does not record search queries or raw content.

Code Butler does not encrypt the SQLite file itself. Use operating-system full-disk encryption and appropriate filesystem permissions. The storage boundary remains isolated so a future encrypted backend can be added without changing the public memory interfaces.

## Memory generation origin

New candidates, durable memories, and temporary memories record where Butler first
created them. The `origin` object contains an installation ID, Butler's operating
system and architecture, generation time, method (`deterministic`, `llm`, or
`manual`), and entrypoint (`sync`, `cli`, or `mcp`). When available it also contains
the MCP client's reported name/version or the configured extraction provider/model.
Client identity is reported metadata, not authenticated proof.

The installation ID is a random UUID stored in `device.json` in Butler's global
directory (`~/.config/code-butler`, or `CODE_BUTLER_HOME`). It is created on memory
creation, not on reads. It is not a hardware fingerprint; Butler does not collect
hostnames, usernames, IP addresses, or hardware identifiers for origin tracking.
Keep this file local when transferring project memory. Copying the global directory
also copies its installation identity.

Origin describes the Butler process that generated a memory, **not where the advice
applies or where the original conversation ran**. Importing Claude logs on Windows
can generate a Windows-origin memory from Claude evidence. A Butler process inside
a Linux container records Linux. Source adapters and evidence references remain
separate from generation origin.

Promotion, duplicate processing, ordinary updates, and lifecycle changes preserve
first origin. New replacement memories receive their own origin. Older records
have `origin: null`, including after updates. Origin is not an edit history and does
not enable cross-device synchronization or OS-based filtering.

Memory-bearing MCP responses include origin. `code-butler memory remember --json`
returns the stored candidate and promoted memory, including origin; its ordinary
output includes a short origin line. Origin is excluded from search text,
embeddings, and deduplication. It follows storage redaction rules and is preserved
by privacy export/import; older exports without origin remain supported.

## Memory scope and applicability

Scope describes where advice applies; origin records where Butler generated it.
New and existing memories default to `{ "kind": "unspecified" }`. This is not a
claim that they apply everywhere. A project scope is explicitly project-wide;
a conditional scope states requirements:

```json
{
  "kind": "conditional",
  "platforms": ["win32"],
  "architectures": ["x64"],
  "shells": ["powershell"],
  "condition": "Only with the legacy watcher enabled"
}
```

Lists are alternatives within a field; fields must all hold. At least one
condition is required. Other conditions, including correlated alternatives such
as Windows with PowerShell OR Linux with Bash, remain text to verify. Familiar
OS, architecture and shell aliases are normalized. Origin and paths never imply
scope. Automatic capture uses explicit leading qualifiers or evidence-backed
classification during existing extraction, without additional model calls.

`remember_project_memory` accepts `scope`. The CLI accepts `--scope-json`:

```sh
code-butler memory remember --type bug_fix --text 'Use polling for this watcher.' --scope-json '{"kind":"conditional","platforms":["win32"]}' --json
code-butler memory scope --id <id> --category promoted --scope-json '{"kind":"project"}' --reason 'Verified on every supported platform' --json
```

The `update_memory_scope` MCP tool accepts `memoryId`, `category`
(`candidate`, `promoted`, or `temporary`), `scope`, and a required `reason`.
Corrections update linked candidates and durable memories transactionally.
Collisions are rejected, not merged. The audit log stores hashes of the identifier
and correction reason, not the reason text. Generation origin remains unchanged.

Retrieval and investigation tools accept an optional `targetEnvironment`, for
example `{ "platform": "linux", "arch": "x64", "shell": "bash" }`. This must
identify where work will actually execute. Providing it replaces the entire
default; omitted values stay unknown. Without it, Butler reports its own OS and
architecture as a provisional host default and does not guess a shell.

Memory results expose `scope` and `applicability`: `project_wide`, `matches`,
`mismatch`, or `needs_verification`, with reasons and the environment used.
Mismatches remain visible and ranking does not change. A matching condition is
not proof that a memory is correct or current. Agents must check scope before
using operational advice; Butler does not enforce their subsequent commands.
Raw source matches remain evidence rather than scoped instructions.

Different scopes keep separate memory identities. Scope is preserved through
promotion and privacy export/import; older exports remain unspecified. Scope
metadata is excluded from embeddings. Secret redaction also applies to scope;
if redaction would collapse separate scoped identities, the operation rolls back
instead of silently merging memories. Schema migration 12 preserves legacy IDs,
origin and lifecycle history. There is no automatic historical reclassification
or device synchronization.
