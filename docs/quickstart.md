# Quick Start

## Requirements

- Node.js 24 or newer
- Git

## Install

Install the CLI from npm:

```bash
npm install -g code-butler
```

## Initialize A Project

Run `init` in each repository where you want the full Code Butler workflow:

```bash
code-butler init
```

`init` creates project-local memory and config files, including an ignored `.code-butler/config.local.json` prefilled with this machine's source paths. It also writes `.code-butler/project-summary.md`, installs short agent bootstrap instructions, and tries to start the per-project background watcher.

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

Put the machine-specific endpoint in the ignored `.code-butler/config.local.json`:

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
```

Conflict review is dry-run by default; add `--fix` to apply its proposed relation and quality changes. Promoted-memory searches use current memories by default, while superseded and retracted memories remain available for explicit historical review.

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
