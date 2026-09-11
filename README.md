# Code Butler

Code Butler gives coding agents an evidence-backed memory of your project.

It is a local-first Project Memory MCP server for Codex, Claude Code, and other
MCP clients. It turns the reasoning already present in local Git history,
coding-agent sessions, and manual decisions into searchable context that an
agent can consult before it changes code.

Ask questions like:

- Why did this file change?
- Where were we before the last session ended?
- What constraints should I know before editing this area?
- Which decision led to this implementation?
- Did we already reject another approach?

In short: Git tells an agent what changed; Code Butler helps it recover why it
changed, what was decided, and which constraints still apply. Project memory
stays local by default in each repository's `.code-butler/` directory.

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

On Windows, install Node.js 24 or newer first and make sure `node`, `npm`, and
`code-butler` are available in a new PowerShell window:

```powershell
node --version
npm --version
code-butler --help
```

Do not install Code Butler into a Codex-managed runtime directory such as
`AppData\Local\OpenAI\Codex\runtimes\...`. Codex may replace those directories
during updates. Use a normal Node.js installation or another stable user-local
Node prefix that you control.

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

If the background watcher cannot be installed, `init` still leaves the project
ready for manual and MCP use. Run `code-butler watch install` again after
fixing scheduler permissions, or keep `code-butler watch` running in a terminal.
On Windows, Code Butler installs a per-user Scheduled Task through a
project-local `.cmd` launcher under `.code-butler/` so the watcher starts in the
right repository.

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

Valid JSONL files without supported Codex or Claude messages are reported as
`unsupported` in source status; malformed or unreadable logs appear in
`code-butler sources failures`.

Refresh the project narrative summary manually:

```bash
code-butler project-summary refresh
code-butler project-summary status
```

If `init` created a fallback summary, add the configured API key and run:

```bash
code-butler project-summary refresh --force
```

If you want to replace a stale or legacy summary with the local fallback summary
while provider credentials are unavailable, run:

```bash
code-butler project-summary refresh --force --fallback
```

Check setup health:

```bash
code-butler doctor
```

## MCP Setup

MCP is how Codex, Claude Code, VS Code, and other agents call Code Butler's
memory tools. The safest setup is to point the client at one project
explicitly:

```bash
npx -y code-butler mcp --project-root /absolute/path/to/project
```

If you installed the CLI globally, use:

```bash
code-butler mcp --project-root /absolute/path/to/project
```

If your MCP client launches servers from inside the active project directory,
you can omit `--project-root`; `code-butler mcp` will resolve the current Git
repository. In either mode, Code Butler creates project-local internal memory
storage on first launch. It does not create `AGENTS.md`, `CLAUDE.md`, or
`.code-butler/project-summary.md`; run `code-butler init` when you are ready
for that explicit setup.

### Add to Codex

Edit `~/.codex/config.toml` and add a server entry:

```toml
[mcp_servers.code-butler]
command = "npx"
args = [
  "-y",
  "code-butler",
  "mcp",
  "--project-root",
  "/absolute/path/to/project"
]
```

If you installed Code Butler globally, use:

```toml
[mcp_servers.code-butler]
command = "code-butler"
args = ["mcp", "--project-root", "/absolute/path/to/project"]
```

For a global Codex setup that works in whichever Git repository the Codex
session is opened in, omit `--project-root`:

```toml
[mcp_servers.code-butler]
command = "code-butler"
args = ["mcp"]
startup_timeout_sec = 120
```

Use the project-pinned form only when you intentionally want one server entry to
always use the same repository regardless of the client's current working
directory.

On Windows, prefer the `.cmd` shim if PowerShell script execution is disabled:

```toml
[mcp_servers.code-butler]
command = "code-butler.cmd"
args = ["mcp"]
startup_timeout_sec = 120
```

Restart the Codex session after editing the config so it starts the MCP server.

### Add to Claude Code

Add Code Butler as a user-scoped Claude Code MCP server:

```bash
claude mcp add --scope user code-butler -- \
  npx -y code-butler mcp --project-root /absolute/path/to/project
```

If your Claude Code version uses the short scope flag:

```bash
claude mcp add -s user code-butler -- \
  npx -y code-butler mcp --project-root /absolute/path/to/project
```

With a global Code Butler install, replace the command after `--`:

```bash
claude mcp add --scope user code-butler -- \
  code-butler mcp --project-root /absolute/path/to/project
```

To remove an older Claude entry first:

```bash
claude mcp list
claude mcp remove code-butler --scope user
```

If the old server was project-scoped, run the remove command from that project
folder and use the scope shown by `claude mcp list`.

### Add to VS Code

If Codex or Claude Code is the only agent you use, the client-specific config
above is enough. To use Code Butler from VS Code, create or edit
`.vscode/mcp.json` inside your project:

```json
{
  "servers": {
    "code-butler": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "code-butler",
        "mcp",
        "--project-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Reload VS Code, or run **MCP: Restart Server** from the command palette.

### Source Builds and Older Configs

If you built Code Butler from source, point clients at the built CLI instead of
the npm package:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp --project-root /absolute/path/to/project
```

For example, a source-built Codex entry would be:

```toml
[mcp_servers.code-butler]
command = "node"
args = [
  "/absolute/path/to/code-butler/dist/cli.js",
  "mcp",
  "--project-root",
  "/absolute/path/to/project"
]
```

After upgrading Code Butler or rebuilding from source, restart any already-open
Codex, Claude, or VS Code MCP sessions. You do not need to re-add the server
unless the command path changed.

If you have older project-local MCP files such as `.mcp.json` or
`.vscode/mcp.json` that point directly at `dist/server.js` or `code-butler
serve`, update them to launch `code-butler mcp` or the built `dist/cli.js`
command shown above.

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

### Windows Source Install And Update

If the npm package is unavailable, or if you want to install from a local
checkout on Windows, use a stable Node.js 24 installation or user-local Node
prefix. Do not use a Codex runtime folder as the permanent install location,
because Codex can rotate those folders during updates.

From PowerShell:

```powershell
cd C:\path\to\CodeButler
git pull

npm ci
.\node_modules\.bin\tsc.cmd -p tsconfig.build.json
npm pack --ignore-scripts
npm install -g .\code-butler-1.0.0.tgz

code-butler --help
```

If you keep a separate stable Node prefix rather than installing Node system
wide, add that prefix to your user `PATH` and run npm from that prefix:

```powershell
$nodePrefix = "$env:LOCALAPPDATA\CodeButler\node24"
$env:PATH = "$nodePrefix;$env:PATH"

& "$nodePrefix\npm.cmd" ci
& ".\node_modules\.bin\tsc.cmd" -p tsconfig.build.json
& "$nodePrefix\npm.cmd" pack --ignore-scripts
& "$nodePrefix\npm.cmd" install -g --prefix $nodePrefix .\code-butler-1.0.0.tgz
```

Then configure Codex globally:

```toml
[mcp_servers.code-butler]
command = "code-butler.cmd"
args = ["mcp"]
startup_timeout_sec = 120
```

If `code-butler.cmd` is not on the environment `PATH` visible to Codex, add a
small server-specific environment block:

```toml
[mcp_servers.code-butler.env]
PATH = 'C:\Users\you\AppData\Local\CodeButler\node24;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0'
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

When watcher installation succeeds, the watcher installed by
`code-butler init` runs the same watch loop automatically. It syncs local
sources and refreshes `.code-butler/project-summary.md` when the daily gated
fingerprint check says the summary is due. It does not rewrite `AGENTS.md` or
`CLAUDE.md`; those bootstrap files are installed only by explicit
`code-butler init`.

Use `watch status` to confirm whether the per-project background watcher is
installed. Code Butler does not silently install a daemon when MCP starts or
when a project is opened; installation is attempted during explicit
`code-butler init`. On Windows, `watch install` creates a per-user Scheduled
Task plus a project-local `.cmd` launcher under `.code-butler/`.

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

## Cloud Sync Beta (Optional)

Cloud sync is an opt-in way to carry a project's Code Butler memory between
your devices. It synchronizes snapshots of Butler's portable project state; it
does not run your agent or MCP tools in the cloud. Local MCP and offline use
continue to work if cloud sync is unavailable.

You need a beta code for the Code Butler cloud service. On your first device,
connect from inside the project, enter that code at the hidden prompt, and
enable the project:

```bash
code-butler cloud connect --server https://cloud.codebutler.dev
code-butler cloud enable
code-butler cloud status
```

On another device, clone or open the code repository first. Then connect with
the same beta code, choose the existing cloud project, and enable it:

```bash
code-butler cloud connect --server https://cloud.codebutler.dev
code-butler cloud projects
code-butler cloud enable --project PROJECT_UUID
```

Restart MCP sessions that were already running after enabling cloud sync. If
both devices make offline changes, synchronization pauses rather than merging
SQLite databases; resolve it explicitly with `code-butler cloud resolve --keep
local` or `code-butler cloud resolve --keep cloud`.

Cloud sync is a beta service, not end-to-end encrypted storage: the server can
read uploaded snapshots, so keep the beta code private and review project-memory
files before enabling it. Device-local credentials, source roots, and sync
cursors are not uploaded. If a conflict appears, both versions are preserved;
pick the version you want to keep explicitly. Disable sync for a checkout with
`code-butler cloud disable`; local memory remains on disk.

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