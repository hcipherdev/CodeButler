# MCP Setup

Install the `code-butler` command first: build from source as described in the
[Quick Start](./quickstart.md), or use the desktop app where it is available (it is
not publicly released yet). The Windows desktop app installs and updates the
matching per-user `code-butler` CLI/MCP runtime. Configure MCP clients to use that
stable command:

```bash
code-butler mcp --project-root /absolute/path/to/project
```

The desktop installer preserves this command across upgrades, refreshes older explicit
CLI compatibility paths, and stops stale managed MCP processes so clients can reconnect
to the new build. No separate npm upgrade is required.

Until Code Butler 2.0 is published to npm, the `npx` and `npm install` commands
below install the earlier 1.x release, whose cloud sync has been retired. Without
the desktop app, an MCP client can launch it with `npx`:

```bash
npx -y code-butler mcp --project-root /absolute/path/to/project
```

Or install the CLI globally:

```bash
npm install -g code-butler
code-butler mcp --project-root /absolute/path/to/project
```

The MCP server resolves the target Git repository and completes project setup automatically after the connection handshake. It creates internal memory storage, a local project summary, `AGENTS.md`, and `CLAUDE.md`, without requiring the desktop app or an API key. Existing agent files are backed up and replaced on first completion; later reconnects preserve user edits and recreate missing files. An existing summary is preserved. A configured provider enriches an unedited local summary in the background, with failures retried no sooner than once per day.

Call `current_project` to inspect its `setup` field for progress, missing artifacts, summary quality, backups, and errors. Desktop readiness and `code-butler doctor` also check both agent files. `code-butler init` remains available for explicit setup; `code-butler mcp --no-auto-init` retains storage-only startup. Automatic setup respects deliberate project-memory removal and does not re-enable it. Restart existing MCP connections after installing a new runtime.

## Global background watching

Install one per-user background watcher, once on each computer:

```sh
code-butler watch install --global
code-butler watch status --global
```

Every project opened through `code-butler mcp` is registered automatically. The global
watcher reloads that registry each pass and continues running after MCP sessions close.
It does not scan arbitrary folders. Register another initialized project explicitly with:

```sh
code-butler watch add --global --project-root /absolute/path/to/project
code-butler watch remove --global --project-root /absolute/path/to/project
```

Opening a removed project through MCP registers it again. `watch uninstall --global`
stops and removes the service, retaining registrations for a later reinstall.

The registry and per-project results live in `~/.config/code-butler/watch` (or
`CODE_BUTLER_HOME/watch`). The watcher runs up to two different projects at once in
isolated child processes, using their own configuration and provider credentials.
It never overlaps jobs for the same project. Full passes become due 30 seconds after
their previous completion; a busy queue can delay their start. Missing folders are
reported without recreating them.

Each full project pass ingests configured sources, refreshes an existing summary when its
daily check is due, and performs enabled cloud sync. Explicit cloud requests, including
AI review Apply and Revert, enter a priority queue and run a cloud-only job without
waiting for ingestion or summary. A request created during a sync remains queued for
the next available worker. One worker continues full passes when both queues have work.
The watcher does not create a summary or
agent bootstrap files in projects that have never requested them. Existing summary
edit protection and provider privacy settings still apply. Status reports whether
the global process is running and the last result for each registered project.
The daily check calls the summary model only when the selected content fingerprint
changes (code, docs, manifests, notes, commits, or promoted memories). Routine sync
timestamps, transient errors and operational counters do not trigger generation.
An unchanged check updates only the local freshness metadata, with no model call.
Narrative generation uses an 8,192-token response budget, independently of the
smaller extraction/investigation profile budgets, to avoid truncated summary JSON.

MCP alone performs local ingestion once at startup and schedules cloud sync; it does
not periodically regenerate summaries. The global watcher provides that ongoing work.
An unchanged MCP startup does not queue another cloud request. Existing per-project
`watch` services remain supported; uninstall a project's old service with
`code-butler watch uninstall` when adopting the global service.

Multiple MCP connections are supported. For each project, the global watcher has
priority for automatic cloud sync. When it is unavailable, one MCP connection (or
legacy project watcher) acquires ownership; other connections continue serving
tools. Ownership is checked every two seconds. On return, the global watcher waits
for the current operation to finish before taking over. Slow live operations are
never displaced just because a timer expires. Explicit cloud sync still uses the
existing operation locks.

Watcher outcomes distinguish success, temporary deferral, and failure. One-shot
watch exits with `0`, `75`, or `1` respectively. A deferred cloud stage does not
erase successful ingestion. Desktop project dots are green for success, amber for
waiting/retrying, red for failure or an unavailable project, and gray before the
first check. The last successful pass remains visible during deferrals.

Use `code-butler runtime` for live process identities, project roots, roles, and
build identifiers; `code-butler --version` reports the installed build. The
desktop's Runtime details shows its own engine and registered running processes.
The content-based build identifier distinguishes builds with the same package
version. The desktop installer stops managed processes from older builds so MCP clients
can reconnect automatically. Independently installed or development MCP processes must
be restarted after an update to load new code.
MCP stdin/transport disconnect now stops scheduled work, drains active operations,
closes the database, and removes its runtime/ownership records.

On Windows, the global task runs hidden at login. If Task Scheduler denies creation,
installation uses a hidden per-user Startup entry instead, without administrator
rights. The Startup entry restarts the watcher at login; unlike Task Scheduler it
does not automatically restart a crashed process. Git is resolved from PATH or a
standard Git for Windows installation; `CODE_BUTLER_GIT` can specify another executable.

## Common Tools

The MCP server exposes 29 tools. Lifecycle and operations calls include:

- `sync_project_memory`
- `list_source_failures`
- `summarize_project_brief`
- `summarize_active_context`
- `search_temporary_memory`
- `search_project_memory`
- `find_memories`
- `remember_project_memory`
- `update_memory_scope({ memoryId, category, scope, reason })`
- `update_memory_layer({ memoryId, category, layer, reason })`
- `suggest_memory_layer_promotions({ layer?, includeCandidates?, minConfidence?, minScore?, limit? })`
- `suggest_branch_memory_triage({ branch?, includeActive?, staleDays?, includeReviewed?, limit? })`
- `resolve_branch_memory_triage({ memoryId, category, action, reason, supersedesMemoryId? })`
- `resolve_memory_review({ memoryId, category, action, reason?, reviewToken?, correction? })`
- `explain_memory_promotions({ memoryId?, limit? })`
- `update_memory_status`
- `explain_code_change`
- `investigate_project_history`
- `summarize_recent_activity`

`find_memories` accepts optional `lifecycleStatus: "current" | "superseded" | "retracted" | "all"`. When omitted, promoted results remain current-only; candidates are unchanged. It also accepts optional `layer: "core" | "device" | "branch" | "all"` and reports each memory's layer; when omitted, every layer is returned. Results include `reviewToken`, the latest `review`, `trust.displayStatus`, and `confidenceBasis`. Pass that token to `resolve_memory_review`; stale tokens are rejected when the memory, evidence, related-file commits, or conflicts changed. Verify preserves numeric extraction confidence and candidate/promotion state, Correct creates a human-authored replacement, and Discard retains the original for audit. `remember_project_memory` accepts optional `layer`; promoted writes default to shared `core`, while `promote: false` defaults to `branch:<name>:device:<installation-id>` when the configured Git repo is on a non-default branch. `suggest_memory_layer_promotions` is read-only and returns suggested promotion actions for non-core durable memories that pass conservative confidence and scope checks; branch candidate suggestions use `resolve_branch_memory_triage` because that path promotes the candidate into a durable `core` memory. `suggest_branch_memory_triage` groups branch-layer memories by Git branch state and hides unchanged reviewed items by default. `explain_memory_promotions` is read-only and reports both what automatic promotion would do now and what it already decided, with privacy-safe reason codes; after each sync Butler applies only unambiguous promotions, converges exact duplicates onto the existing core fact, defers contradictions as `needs_review`, and honours an explicit `retain_branch` or `discard` review over its own policy. Candidates already in `core` are promoted when a person verified them (desktop or CLI, no confidence bar), their evidence spans two independent sources (confidence ≥ `promotion.confidenceThreshold`), or an AI review judged them current, excluding replacements that review wrote itself (confidence ≥ `promotion.automatic.singleSourceMinConfidence`, default 0.90); `resolve_memory_review` verification from MCP does not count, and MCP can still verify only memories that need review. Turn that off with `promotion.automatic.coreCandidates: false`. Disable it with `promotion.automatic.enabled: false`. `resolve_branch_memory_triage` explicitly `promote_to_core`, `discard`, or `retain_branch` for reviewed branch memories. `update_memory_layer` moves an existing memory between layers and accepts `device` as an alias for this installation's device layer. `remember_project_memory` accepts `supersedesMemoryId` for promoted replacements. `update_memory_status` requires a nonempty `memoryId`, lifecycle `status`, and `reason`; `superseded` also requires `replacementMemoryId`.

`list_source_failures` accepts optional `adapter`, `resolved`, and bounded `limit` filters. Messages are sanitized and never include raw parser lines. Repairing and successfully reparsing a source resolves its persisted failures automatically.

Search is FTS-only by default. With optional hybrid retrieval configured, `search_project_memory` and `find_memories` may add `ranking.lexicalRank`, `ranking.semanticRank`, and `ranking.fusedScore` to ranked results. Existing fields and required parameters are unchanged. If semantic ranking is unavailable for any reason, the MCP response is exactly the FTS response and contains no ranking metadata.

Embedding setup and queue management use the CLI (`code-butler embeddings build` and `code-butler embeddings status`); there is no MCP embeddings tool. Remote embedding endpoints require explicit privacy opt-in and always receive redacted text. Code Butler never automatically falls back to a remote endpoint.

## Recommended Agent Flow

Start by syncing memory and reading the project brief. When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write the SQLite database directly. When a fact changes, supersede it with a current replacement; retract it when it was invalid and has no replacement. Use `code-butler memory conflicts` for a dry-run review of current-memory conflicts and `--fix` only when the proposed relation and quality changes are appropriate. For continuation questions, summarize active context first. For file-specific questions, use code-change explanation and project memory search before editing.

## See Also

[Architecture overview](/architecture.html) — full system diagram with pipeline stages, layer stack, and data flows.
