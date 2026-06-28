# Code Butler

Code Butler gives coding agents a project memory they can actually use.

It is a local-first Project Memory MCP server for Codex, Claude Code, and other
MCP clients. Code Butler indexes local evidence from Git commits, Codex
sessions, Claude sessions, and manual decision records, then exposes that
memory through tools an agent can call before it edits your code.

Ask questions like:

- Why did this file change?
- Where were we before the last session ended?
- What constraints should I know before editing this area?
- Which decision led to this implementation?
- Did we already reject another approach?

Project memory stays local by default in each repository's `.code-butler/`
directory.

## Why Use It

Most project context is scattered across commits, chat logs, notes, and stale
agent instructions. Code Butler turns that scattered evidence into a searchable
memory layer for day-to-day agent work.

Use it to:

- Resume work after a long gap, a compacted thread, or a handoff between agents.
- Explain file history using both commits and the conversations that led to
  them.
- Preserve accepted decisions, project constraints, bug fixes, and rejected
  approaches.
- Keep a generated project narrative summary available for future agents.
- Search temporary working context separately from durable project memory.
- Audit memory quality and diagnose setup issues with `code-butler doctor`.

## How It Compares

Code Butler does not replace Git, your agent instructions, or your notes. It
connects them.

| Common pattern | What you get | What Code Butler adds |
| --- | --- | --- |
| Git history | What changed | Why it changed, with related conversation and decision evidence |
| Raw chat logs | Full conversation text | Project-scoped sync, search, summaries, and MCP tools |
| `AGENTS.md` / `CLAUDE.md` as memory | Instructions agents can read | Stable bootstrap files that point agents to fresh local memory |
| Manual notes | Human-written context | Evidence-backed memories, candidates, and generated summaries |

## What It Remembers

Code Butler has three memory layers:

- **Temporary working context** for recent Codex and Claude activity. This is
  useful for "continue" and "where were we?" questions.
- **Candidate memories** extracted from commits and conversations that may need
  more evidence.
- **Durable memories** for accepted decisions, constraints, bug fixes, and
  rejected approaches.

Memory can come from:

- Git commits and changed files.
- Codex logs from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Claude logs from `~/.claude/projects`.
- Manual conversation imports.
- Manual decision records.
- Optional LLM extraction when a provider API key is configured.
- Deterministic directives such as `remember this decision: ...` or
  `remember this constraint: ...`, which work without an LLM.

## Requirements

- Node.js 24 or newer
- Git

## Quick Start

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Recommended: initialize Code Butler in each project where you want agents to
use the full memory workflow:

```bash
node dist/cli.js init
```

`init` is the explicit opt-in setup step and the best default for real
projects. It creates project-local memory, writes
`.code-butler/project-summary.md`, and backs up existing
`AGENTS.md` / `CLAUDE.md` beside the originals as
`*.code-butler-backup-<timestamp>` before replacing them with short Butler
bootstrap instructions.

Those bootstrap files are what make future Codex or Claude sessions naturally
use Code Butler before editing. The project summary gives agents a fast
starting brief, while the MCP tools provide the detailed evidence behind it.

Without `init`, Code Butler can still run as a lighter indexing and search
layer through MCP tools, but it is not operating at full potential: there is no
project summary, no agent bootstrap instructions, and
`summarize_project_brief` reports that no summary exists.

There is no separate `project-summary install` step for normal use. `init`
creates the first summary and bootstrap files; `project-summary refresh` and
`project-summary status` are the ongoing summary commands.

If no API key is available, Code Butler creates a limited fallback summary,
records it as a fallback in summary metadata, and tells you how to regenerate a
richer one later.
Opening a folder, starting MCP, running `sync`, or asking an agent for the
project brief does not rewrite visible project files before `init`.

Run an incremental sync:

```bash
node dist/cli.js sync
```

Inspect source status:

```bash
node dist/cli.js sources status
```

Refresh the project narrative summary manually:

```bash
node dist/cli.js project-summary refresh
node dist/cli.js project-summary status
```

If `init` created a fallback summary, add the configured API key and run:

```bash
node dist/cli.js project-summary refresh --force
```

Check setup health:

```bash
node dist/cli.js doctor
```

During development, you can run the TypeScript entrypoint directly:

```bash
npx tsx src/cli.ts --help
```

## MCP Setup

Build the project first:

```bash
npm run build
```

Then configure your MCP client to launch Code Butler:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp
```

`code-butler mcp` resolves the current Git repository and creates project-local
internal memory storage on first launch. It does not create `AGENTS.md`,
`CLAUDE.md`, or `.code-butler/project-summary.md`; run `code-butler init` when
you are ready for that explicit setup. If the MCP client starts outside the
target repository, pass an explicit project root:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp --project-root /absolute/path/to/project
```

Once connected, agents can call tools such as:

- `sync_project_memory`
- `summarize_project_brief`
- `summarize_active_context`
- `search_temporary_memory`
- `search_project_memory`
- `find_memories`
- `explain_code_change`
- `investigate_project_history`
- `summarize_recent_activity`

## Daily Workflow

Keep memory fresh in the foreground while you work:

```bash
node dist/cli.js watch
```

Install a macOS user watcher for regular background sync and summary refresh:

```bash
node dist/cli.js watch install
node dist/cli.js watch status
```

The installed watcher runs the same watch loop automatically. It syncs local
sources and refreshes `.code-butler/project-summary.md` when the daily gated
fingerprint check says the summary is due. It does not rewrite `AGENTS.md` or
`CLAUDE.md`; those bootstrap files are installed only by explicit
`code-butler init`.

Use `watch status` to confirm whether the per-project macOS launchd job is
installed. Background refresh is opt-in; Code Butler does not silently install
a daemon when MCP starts or when a project is opened.

Remove the watcher:

```bash
node dist/cli.js watch uninstall
```

Ask your agent to sync before project-history questions:

```text
Use Code Butler to sync project memory, then tell me what changed recently and why.
```

For continuation after a break or compacted thread:

```text
Use Code Butler's active context first. Where were we, and what should I do next?
```

For file-specific history:

```text
Use Code Butler to explain why src/cache.ts changed and what discussion led to it.
```

For durable instructions, keep `AGENTS.md` and `CLAUDE.md` short. They should
tell agents how to consult Code Butler, not try to store the project's memory
themselves.

## Manual Memory

Add a durable decision manually:

```bash
node dist/cli.js decision add \
  --topic "cache invalidation" \
  --decision "Invalidate cache after writes" \
  --reason "Avoid stale reads after mutation" \
  --evidence commit:abc123
```

Import a conversation export:

```bash
node dist/cli.js ingest conversation ./session.md
node dist/cli.js ingest conversation ./session.jsonl
```

Audit memory quality:

```bash
node dist/cli.js memory audit
node dist/cli.js memory audit --fix
```

## Privacy / Local State

Code Butler stores project state under `.code-butler/` in the repository being
indexed. That directory can include config files, SQLite databases, sync
cursors, conversation imports, and generated project summaries.

Keep real local state private:

- Do not commit `.code-butler/config.json` if it contains machine-specific
  paths or settings.
- Do not commit `.code-butler/.env` or any API keys.
- Do not commit `.code-butler/memory.sqlite` or imported conversation logs.
- Use generated example config files as references only.

LLM extraction is optional. Raw sync, deterministic directives, manual
decisions, and MCP search still work without a provider API key.

## Testing

Run the full test suite:

```bash
npm test
```

Run the type checker:

```bash
npm run typecheck
```

Build the package:

```bash
npm run build
```

Run the public export tests:

```bash
npm run test:public-sync
```
