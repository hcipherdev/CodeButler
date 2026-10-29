# Quick Start

## Requirements

- Node.js 24 or newer
- Git

## Install

Code Butler 2.0 is not on npm yet; the npm registry still serves 1.x, whose cloud
sync has been retired. Build and install the current version from source:

```bash
git clone https://github.com/hcipherdev/CodeButler.git
cd CodeButler
npm ci
npm run package:crypto   # optional: macOS or Windows with Rust, needed for encrypted cloud sync
npm pack
npm install -g ./code-butler-2.0.0.tgz
```

`npm pack` builds the package first. Skip `npm run package:crypto` if you only need
local memory.

The Code Butler desktop app is not publicly released yet. Its installer manages the
desktop, CLI, MCP server, native helper, and global watcher as one compatible
release. Do not install a second global CLI when using the desktop installer; it
provides the stable `code-butler` command and keeps existing MCP launch paths current.

## Initialize A Project

Run `init` in each repository where you want the full Code Butler workflow:

```bash
code-butler init
```

`init` creates project-local memory and a sparse `.code-butler/config.json`, and
automatically initializes the per-user global configuration with this machine's
source paths. It also writes `.code-butler/project-summary.md`, installs short
agent bootstrap instructions, and tries to start the per-project background
watcher.

LLM extraction is opt-in. If the only provider key is one exported in your
shell, such as `OPENAI_API_KEY`, `init` asks before sending anything to that
provider, and stays off when it cannot ask. Pass `--allow-remote-models`, or run
`code-butler config remote-models on` later. A provider you configure in the
desktop app or a config file needs no extra step. See
[privacy](privacy.md#remote-ai-models).

## Sync Memory

Run an incremental sync:

```bash
code-butler sync
```

Check setup health:

```bash
code-butler doctor
```

Search uses local SQLite FTS by default and needs no model, provider, or network connection.

## Optional Hybrid Search

For semantic ranking with a local OpenAI-compatible Ollama service, first install the embedding model:

```bash
ollama pull nomic-embed-text
```

Merge the shared policy into `.code-butler/config.json`:

```json
{
  "retrieval": { "mode": "hybrid", "rrfK": 60 },
  "privacy": { "allowRemoteEmbeddings": false }
}
```

Put the machine-specific endpoint in the global configuration at
`~/.config/code-butler/config.json` (or `CODE_BUTLER_HOME`):

```json
{
  "embeddings": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 16
  }
}
```

Build and inspect the index:

```bash
code-butler embeddings build
code-butler embeddings status
```

Failed jobs remain retryable. If the provider or compatible vectors are unavailable, searches return the exact FTS result. Remote endpoints require `privacy.allowRemoteEmbeddings: true`; outbound text is always redacted and Code Butler never falls back automatically to a network provider.

Review durable-memory lifecycle and conflicts:

```bash
code-butler memory conflicts
code-butler memory status --id <memory-id> --status retracted --reason "Incorrect guidance"
code-butler memory review --id <memory-id> --category candidate --action verify
```

Conflict review is dry-run by default; add `--fix` to apply its proposed relation and quality changes. Promoted-memory searches use current memories by default, while superseded and retracted memories remain available for explicit historical review.
Verify preserves extraction confidence and does not promote candidates. Correct and Discard require `--reason`; Correct also accepts `--correction-json`. Passing `--review-token` prevents acting on evidence that changed since the memory was opened.

Refresh the generated project summary manually:

```bash
code-butler project-summary refresh
```

Put durable human guidance in `.code-butler/project-summary-notes.md`; refresh reads it but never rewrites it. Code context is selected deterministically from safe Git-tracked entrypoints, promoted-memory links, and recent commit files. Normal refresh protects manual edits to the generated summary; use `project-summary status` to inspect the state and `refresh --force` only when you intend to replace it with a timestamped recovery backup.

If provider credentials are unavailable and you want a local fallback summary instead of waiting, use:

```bash
code-butler project-summary refresh --force --fallback
```

Background watcher installation is best effort during `init`. If the scheduler step fails, Code Butler remains usable through manual commands and MCP; run `code-butler watch install` after fixing scheduler permissions, or keep `code-butler watch` open in a terminal. On Windows, the watcher uses a per-user Scheduled Task that runs a project-local `.cmd` launcher from `.code-butler/`.

Inspect persisted conversation parsing failures after repairing source files:

```bash
code-butler sources failures
code-butler sources failures --json
```

Valid JSONL files that contain no supported Codex or Claude messages are counted
as unsupported in `code-butler sources status`; they are not persisted as
unresolved failures.

## Build From Source

```bash
npm install
npm run build
node dist/cli.js --help
```

Run the checked-in, offline retrieval evaluation with:

```bash
npm run eval:retrieval
```
