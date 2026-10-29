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
stays local in each repository's `.code-butler/` directory. An experimental,
invite-only [encrypted cloud sync](#encrypted-cloud-sync-experimental) can carry
it between your computers.

> **Requires Node.js 24 or newer and Git** on macOS, Windows, or Linux. Install
> from source for now (see [Quick Start](#quick-start)); the npm package is
> still the retired 1.x release.

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
- Optionally, sync memory across your computers with experimental end-to-end
  encrypted cloud sync (invite-only, not yet independently audited).

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
- Optional LLM extraction, off until you choose a provider or opt in.
- Deterministic directives such as `remember this decision: ...` or
  `remember this constraint: ...`, which work without an LLM.

## Requirements

- macOS, Windows, or Linux
- Node.js 24 or newer. Code Butler uses Node's built-in SQLite support, so
  older Node versions cannot run it. Some earlier Node 24 releases print a
  harmless SQLite `ExperimentalWarning`; updating Node removes it.
- Git
- For encrypted cloud sync only: macOS or Windows, and a Rust toolchain to build
  the native crypto helper (see Quick Start)

## Quick Start

> **Install from source.** This repository is Code Butler 2.0. The npm registry
> still has the retired 1.x release, so do not use `npx code-butler` or
> `npm install -g code-butler` until 2.0 is published there.

Install from source on macOS, Windows, or Linux. Local project memory works on
all three. Encrypted cloud sync needs the native crypto helper, which builds on
macOS and Windows only.

### macOS

Install the prerequisites once:

- Node.js 24 or newer, from [nodejs.org](https://nodejs.org/) or Homebrew
  (`brew install node`). With Homebrew or a version manager such as nvm,
  `npm install -g` works without `sudo`; do not use `sudo` with npm.
- Git and the compiler tools: `xcode-select --install`
- Only for encrypted cloud sync, Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
  then open a new terminal.

Build and install:

```bash
git clone https://github.com/hcipherdev/CodeButler.git
cd CodeButler
npm ci
npm run package:crypto   # only for encrypted cloud sync; needs Rust
npm pack
npm install -g ./code-butler-2.0.0.tgz
code-butler --version
```

`npm pack` builds the package and names the file after the version in
`package.json`.

### Windows

Install the prerequisites once:

- Node.js 24 or newer from [nodejs.org](https://nodejs.org/) (keep "Add to PATH"
  selected).
- [Git for Windows](https://git-scm.com/download/win).
- Only for encrypted cloud sync, Rust from [rustup.rs](https://rustup.rs/). When
  `rustup-init.exe` asks, install the Visual Studio C++ Build Tools ("Desktop
  development with C++").

Then open a **new** PowerShell window, so the new tools are on `PATH`:

```powershell
node --version   # must be v24 or newer
git clone https://github.com/hcipherdev/CodeButler.git
cd CodeButler
npm ci
npm run package:crypto   # only for encrypted cloud sync; needs Rust
npm pack
npm install -g .\code-butler-2.0.0.tgz
code-butler --version
```

If PowerShell reports that running scripts is disabled, use `npm.cmd` and
`code-butler.cmd` instead of `npm` and `code-butler`, or allow local scripts for
your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. If
`code-butler` is not found, open a new PowerShell window and check that the
folder printed by `npm prefix -g` is on your `PATH`.

Do not install Code Butler into a Codex-managed runtime directory such as
`AppData\Local\OpenAI\Codex\runtimes\...`. Codex may replace those directories
during updates. Use a normal Node.js installation or another stable user-local
Node prefix that you control (see
[Windows Source Install And Update](#windows-source-install-and-update)).

### Linux

Follow the macOS steps without `npm run package:crypto`, installing Node.js 24
or newer and Git with your package manager. Encrypted cloud sync is not
available on Linux yet.

### Update

From your `CodeButler` folder, pull and reinstall:

```bash
git pull
npm ci
npm run package:crypto   # only if you use encrypted cloud sync
npm pack
npm install -g ./code-butler-2.0.0.tgz   # use the file name npm pack prints
```

### Set up a project

Recommended: initialize Code Butler in each project where you want agents to
use the full memory workflow:

```bash
code-butler init
```

`init` is the explicit opt-in setup step and the best default for real
projects. It creates project-local memory and config files, including the
ignored `.code-butler/config.local.json` prefilled with this machine's source
paths. It also writes `.code-butler/project-summary.md` and backs up existing
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

These examples use the `code-butler` command installed in Quick Start.

MCP is how Codex, Claude Code, VS Code, and other agents call Code Butler's
memory tools. The safest setup is to point the client at one project
explicitly:

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
  code-butler mcp --project-root /absolute/path/to/project
```

If your Claude Code version uses the short scope flag:

```bash
claude mcp add -s user code-butler -- \
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
      "command": "code-butler",
      "args": ["mcp", "--project-root", "/absolute/path/to/project"]
    }
  }
}
```

Reload VS Code, or run **MCP: Restart Server** from the command palette.

### Source Builds and Older Configs

If you built Code Butler from source without installing the package globally,
point clients at the built CLI instead:

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

All 34 tools and their inputs are listed in
[MCP setup](docs/mcp-setup.md#mcp-tools).

## Build From Source

The Quick Start installs from source. For development, clone the repository,
install dependencies, and build the CLI without installing it globally:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/cli.js --help
```

Encrypted cloud sync also needs the native crypto helper. On macOS or Windows,
with a Rust toolchain installed, build it into the package layout:

```bash
npm run package:crypto
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

The Windows steps in Quick Start are the usual install. Use this variant to
install into a separate, stable user-local Node prefix. Use a stable Node.js 24
installation or user-local Node prefix. Do not use a Codex runtime folder as the permanent install location,
because Codex can rotate those folders during updates.

From PowerShell:

```powershell
cd C:\path\to\CodeButler
git pull

npm ci
.\node_modules\.bin\tsc.cmd -p tsconfig.build.json
npm run package:crypto   # optional: needs Rust; required for encrypted cloud sync
npm pack --ignore-scripts
npm install -g .\code-butler-2.0.0.tgz

code-butler --help
```

If you keep a separate stable Node prefix rather than installing Node system
wide, add that prefix to your user `PATH` and run npm from that prefix:

```powershell
$nodePrefix = "$env:LOCALAPPDATA\CodeButler\node24"
$env:PATH = "$nodePrefix;$env:PATH"

& "$nodePrefix\npm.cmd" ci
& ".\node_modules\.bin\tsc.cmd" -p tsconfig.build.json
& "$nodePrefix\npm.cmd" run package:crypto
& "$nodePrefix\npm.cmd" pack --ignore-scripts
& "$nodePrefix\npm.cmd" install -g --prefix $nodePrefix .\code-butler-2.0.0.tgz
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

## Encrypted Cloud Sync (Experimental)

> **Experimental and invite-only.** Public registration is closed. The
> cryptography and protocol have not been independently audited, and release
> qualification (clean-device recovery, lost-device revocation, cross-platform
> pairing, backup restore) is still in progress. Local memory is the supported
> product; do not rely on cloud sync as your only copy.

Cloud sync is an opt-in way to carry a project's Code Butler memory between
your computers. It does not run your agent or MCP tools in the cloud, and local
MCP and offline use keep working when cloud sync is unavailable.

Memory content is encrypted on your own computer before upload. The server
stores ciphertext and a signed device registry; it still sees metadata such as
opaque identifiers, object sizes, timing, and device labels. The design goal is
that neither the operator nor someone who breaches the server can read memory
content; that goal has not yet been verified by an outside review.

Project keys travel between your computers with hybrid X25519 + ML-KEM-768 key
delivery, and data is sealed with ChaCha20-Poly1305. Device signatures and
authentication use classical Ed25519, so the system as a whole is not
post-quantum secure.

A native helper (`butler-crypto`, built from `native/` in this repository)
keeps private keys out of JavaScript and stores them in Windows DPAPI or the
macOS Keychain. Cloud sync currently runs on macOS and Windows. The
[encrypted sync protocol](docs/encrypted-sync-protocol.md) lists what the
server can and cannot observe and the known limitations; security reports are
welcome through [SECURITY.md](SECURITY.md).

Cloud sync needs a source build that includes the native helper
(`npm run package:crypto`, see Quick Start). A desktop app for managing
accounts, passkeys, and new computers is not publicly released yet. While cloud
sync is experimental, registration on the hosted service is closed; open an
issue if you want to take part in testing. From the CLI, on your first computer:

```bash
code-butler cloud register --server https://cloud.codebutler.dev --email you@example.com
code-butler cloud init --recovery-file ./code-butler-recovery.json
code-butler cloud enable --new
code-butler cloud status
```

`register` sends an email code, then asks for a new password at a hidden
prompt. `init` creates your encrypted vault and writes an offline recovery file;
it prints a separate recovery code. Store both somewhere safe and offline. They
are the only way back in if you lose every approved computer.

To add another computer, sign in there and request approval:

```bash
code-butler cloud login --server https://cloud.codebutler.dev --email you@example.com
code-butler cloud device request
```

Compare the printed fingerprint and approve it from a computer that is already
approved (in the desktop Account Center, or with
`code-butler cloud device approve --fingerprint <fingerprint>`). Then run
`code-butler cloud device complete` on the new computer until it reports
`enrolled`, and in a checkout of the same code repository list and connect the
project:

```bash
code-butler cloud projects
code-butler cloud enable --project PROJECT_UUID
```

Restart MCP sessions that were already running after enabling cloud sync. If
both computers change memory offline, Code Butler merges what it can and pauses
on real conflicts; resolve them with `code-butler cloud resolve --keep local` or
`--keep cloud`. Remove a lost computer with `code-butler cloud device revoke
--device DEVICE_ID`, which also rotates project keys. Disable sync for a
checkout with `code-butler cloud disable`; local memory remains on disk.

### Upgrading from 1.x cloud sync

The 1.x beta cloud service (beta codes, `code-butler cloud connect`) has been
retired, and its storage was readable by the server. Your local memory is
unaffected. To keep syncing, register an account as above and enable each
project again with `code-butler cloud enable --new` on one computer.

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

LLM extraction is optional and opt-in. Code Butler sends redacted transcripts
and diffs only to a provider you chose: a connection saved in the desktop app,
a provider block in a config file, or a local model server. A key that merely
sits in your shell environment, such as an exported `OPENAI_API_KEY`, does not
switch it on. To use the built-in default model, run
`code-butler config remote-models on` (or `code-butler init --allow-remote-models`).
Raw sync, deterministic directives, manual decisions, and MCP search work
without any model. See [privacy](docs/privacy.md#remote-ai-models).

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
