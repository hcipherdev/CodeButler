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

## What It Looks Like

Representative example:

```text
User: Use Code Butler to explain why src/cache.ts changed before you edit it.

Agent: I synced project memory and found:
- related commits that changed src/cache.ts
- conversation context explaining the cache invalidation issue
- a durable decision to invalidate cache entries after writes
- a rejected approach that tried time-based expiry only

The current constraint is: keep writes synchronous with cache invalidation so
future reads cannot observe stale data.
```

The exact answer depends on the local evidence in your repository. Code Butler
does not invent remote project knowledge; it searches the Git history,
conversation logs, decisions, and summaries available on your machine.

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

- Node.js 24 or newer. Code Butler uses Node's built-in SQLite support.
- Git

## Quick Start

Install the Code Butler CLI from npm:

```bash
npm install -g code-butler
```

Recommended: initialize Code Butler in each project where you want agents to
use the full memory workflow:

```bash
code-butler init
```

`init` is the explicit opt-in setup step and the best default for real
projects. It creates project-local memory, writes
`.code-butler/project-summary.md`, and backs up existing
`AGENTS.md` / `CLAUDE.md` beside the originals as
`*.code-butler-backup-<timestamp>` before replacing them with short Butler
bootstrap instructions. It also installs and starts the per-project background
watcher so local memory and the project summary stay fresh after setup.

Those bootstrap files are what make future Codex or Claude sessions naturally
use Code Butler before editing. The project summary gives agents a fast
starting brief, while the MCP tools provide the detailed evidence behind it.

Without `init`, Code Butler can still run as a lighter indexing and search
layer through MCP tools, but it is not operating at full potential: there is no
project summary, no agent bootstrap instructions, and
`summarize_project_brief` reports that no summary exists.

There is no separate `project-summary install` step for normal use. `init`
creates the first summary, bootstrap files, and background updater;
`project-summary refresh` and `project-summary status` remain available for
manual checks.

If no API key is available, Code Butler creates a limited fallback summary,
records it as a fallback in summary metadata, and tells you how to regenerate a
richer one later.
Opening a folder, starting MCP, running `sync`, or asking an agent for the
project brief does not rewrite visible project files before `init`.

Run an incremental sync:

```bash
code-butler sync
```

Inspect source status:

```bash
code-butler sources status
```

Refresh the project narrative summary manually:

```bash
code-butler project-summary refresh
code-butler project-summary status
```

If `init` created a fallback summary, add the configured API key and run:

```bash
code-butler project-summary refresh --force
```

Check setup health:

```bash
code-butler doctor
```

## MCP Setup

Configure your MCP client to launch Code Butler with `npx`:

```bash
npx -y code-butler mcp --project-root /absolute/path/to/project
```

Or use a global install:

```bash
code-butler mcp --project-root /absolute/path/to/project
```

`code-butler mcp` resolves the target Git repository and creates project-local
internal memory storage on first launch. It does not create `AGENTS.md`,
`CLAUDE.md`, or `.code-butler/project-summary.md`; run `code-butler init` when
you are ready for that explicit setup.

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

## Build From Source

Clone the repository, install dependencies, and build the CLI:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/cli.js --help
```

During development, you can run the TypeScript entrypoint directly:

```bash
npx tsx src/cli.ts --help
```

For source-built MCP setup, point your MCP client at the built CLI:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp --project-root /absolute/path/to/project
```

## Daily Workflow

Keep memory fresh in the foreground while you work:

```bash
code-butler watch
```

Check the installed background watcher:

```bash
code-butler watch status
```

The watcher installed by `code-butler init` runs the same watch loop
automatically. It syncs local sources and refreshes
`.code-butler/project-summary.md` when the daily gated fingerprint check says
the summary is due. It does not rewrite `AGENTS.md` or `CLAUDE.md`; those
bootstrap files are installed only by explicit `code-butler init`.

Use `watch status` to confirm whether the per-project background watcher is
installed. Code Butler does not silently install a daemon when MCP starts or
when a project is opened; installation happens during explicit
`code-butler init`.

Remove the watcher:

```bash
code-butler watch uninstall
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
code-butler decision add \
  --topic "cache invalidation" \
  --decision "Invalidate cache after writes" \
  --reason "Avoid stale reads after mutation" \
  --evidence commit:abc123
```

Import a conversation export:

```bash
code-butler ingest conversation ./session.md
code-butler ingest conversation ./session.jsonl
```

Audit memory quality:

```bash
code-butler memory audit
code-butler memory audit --fix
```

## Privacy / Local State

Code Butler stores project state under `.code-butler/` in the repository being
indexed. That directory can include config files, SQLite databases, sync
cursors, conversation imports, and generated project summaries.

Generated project `.code-butler/.gitignore` files ignore all `.code-butler/`
contents by default except `.code-butler/project-summary.md`. This keeps local
runtime memory out of `git status` while still allowing a curated narrative
summary to be tracked when you want it.

Keep real local state private:

- Keep `.code-butler/config.json` local if it contains machine-specific paths
  or settings.
- Never commit `.code-butler/.env` or any API keys.
- Never commit `.code-butler/memory.sqlite`, SQLite sidecars, sync metadata,
  backups, or imported conversation logs.
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
