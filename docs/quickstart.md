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

`init` creates project-local memory, writes `.code-butler/project-summary.md`, installs short agent bootstrap instructions, and starts the per-project background watcher.

## Sync Memory

Run an incremental sync:

```bash
code-butler sync
```

Check setup health:

```bash
code-butler doctor
```

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

## Build From Source

```bash
npm install
npm run build
node dist/cli.js --help
```
