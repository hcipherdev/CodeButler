# MCP Setup

Install the `code-butler` command from npm or from source as described in the
[Quick Start](./quickstart.md). The Windows desktop app installs and updates the
matching per-user `code-butler` CLI/MCP runtime. Configure MCP clients to use that
stable command once, globally, with no project argument:

```bash
claude mcp add --scope user code-butler -- code-butler mcp
codex mcp add code-butler -- code-butler mcp
```

`code-butler clients connect <claude|codex>` does the same with the installed command's
full path. The desktop app and the macOS package connect each installed client once
automatically.

The desktop installer preserves this command across upgrades, refreshes older explicit
CLI compatibility paths, and stops stale managed MCP processes so clients can reconnect
to the new build. No separate npm upgrade is required.

### How a connection chooses its project

One registered server serves every repository. Each connection picks its project in
this order:

1. `--project-root <path>` or `CODE_BUTLER_PROJECT_ROOT`, then the Git repository
   containing the folder the client started the server in. These are fixed at launch.
2. When the client started it outside any repository, the first of the client's MCP
   roots (workspace folders) inside a Git repository. A roots change moves the
   connection to the new repository.
3. Otherwise, the agent's working directory: `current_project({ projectRoot })` with an
   absolute path binds the repository containing it. An agent-chosen project can move
   to another repository the same way; a project fixed at launch or chosen from roots
   cannot, and the call explains why.

Until a project is bound, the server still connects and lists every tool.
`current_project` reports `{ bound: false, reason, hint }`, and every other tool fails
with a `no_project` error that tells the agent to pass its working directory. The
server instructions say the same, because a repository that has never been bound has
no generated `AGENTS.md` or `CLAUDE.md` yet. `code-butler clients status` starts the
installed command from a folder outside any project and checks that it answers
`initialize` and `tools/list`, the way a client does.

Automatic initialization of new projects is **off by default**. Enable **Settings → General → Automatically initialize new projects** in the desktop app to opt in on this computer. This preference is stored in the device's global `config.json` as `general.autoInitializeProjects`; repository settings cannot enable it. Without opt-in, connecting MCP to a new folder leaves it untouched: no `.code-butler/`, summary, agent guidance files, or watcher registration. The connection stays available, and `current_project` explains how to set up the folder. Existing initialized projects continue serving memory.

Use **Add project** in the desktop app and confirm setup, or run `code-butler init`, to initialize a folder explicitly while the preference is off. After that, ask the agent to call `current_project` again or reconnect. After enabling the preference, the same check can initialize a pending project without changing the coding tool's MCP registration.

With opt-in enabled, the MCP server completes project setup after the connection handshake. It creates internal memory storage, a local project summary, `AGENTS.md`, and `CLAUDE.md`, without requiring an API key. Existing summaries and user edits are preserved. A configured provider can enrich an unedited local summary in the background; the built-in default model requires remote-model consent. See [privacy](privacy.md#remote-ai-models).

Call `current_project` to inspect its `setup` field once initialized. Desktop readiness and `code-butler doctor` also check both agent files. `code-butler mcp --no-auto-init` disables automatic initialization for that connection even when the device preference is on; it does not create storage in new projects. Automatic setup respects deliberate project-memory removal. Reconnect existing MCP clients after installing a new runtime.

## Global background watching

Install one per-user background watcher, once on each computer:

```sh
code-butler watch install --global
code-butler watch status --global
```

Every initialized project opened through `code-butler mcp` is registered automatically. The global
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

## MCP Tools

The MCP server exposes 34 tools. `tests/docs/mcp-tool-docs.test.ts` keeps this list in step with the registered tools.

Project, sync and health:

- `current_project({ projectRoot? })`
- `sync_project_memory({ source? })`
- `summarize_project_state()`
- `list_source_failures({ adapter?, resolved?, limit? })`
- `run_doctor()`
- `summarize_project_brief()`
- `refresh_project_summary({ force? })`

Search and reading:

- `search_project_memory({ query, sourceTypes?, limit?, targetEnvironment? })`
- `find_memories({ query?, type?, status?, qualityStatus?, lifecycleStatus?, layer?, owner?, limit?, targetEnvironment? })`
- `find_decisions({ topic?, limit?, targetEnvironment? })`
- `find_related_commits({ query?, filePath?, limit? })`
- `read_memory_source({ sourceId })`
- `get_memory_history({ id, category, offset?, limit? })`
- `read_project_handbook({ topicId?, reach?, owner?, offset?, limit? })`
- `summarize_memory_movement({ reach?, owner? })`
- `summarize_memory_health()`

Writing and lifecycle:

- `remember_project_memory({ type, text, title?, reason?, relatedFiles?, promote?, supersedesMemoryId?, scope?, layer? })`
- `update_memory_scope({ memoryId, category, scope, reason })`
- `update_memory_layer({ memoryId, category, layer, reason })`
- `update_memory_status({ memoryId, status, reason, replacementMemoryId? })`
- `resolve_memory_review({ memoryId, category, action, reason?, reviewToken?, correction? })`
- `suggest_memory_layer_promotions({ layer?, includeCandidates?, minConfidence?, minScore?, limit? })`
- `suggest_branch_memory_triage({ branch?, includeActive?, staleDays?, includeReviewed?, limit? })`
- `resolve_branch_memory_triage({ memoryId, category, action, reason, supersedesMemoryId? })`
- `explain_memory_promotions({ memoryId?, limit? })`
- `explain_layer_retention({ memoryId?, limit? })`

History and investigation:

- `explain_code_change({ filePath, lineNumber?, question?, targetEnvironment? })`
- `investigate_project_history({ question, limit?, targetEnvironment? })`
- `summarize_recent_activity({ since?, until?, includeWorkingTree? })`

Temporary working context:

- `search_temporary_memory({ query, threadId?, sessionId?, limit?, targetEnvironment? })`
- `summarize_active_context({ threadId?, sessionId?, projectOnly?, limit?, targetEnvironment? })`
- `cleanup_temporary_memory({ expiredOnly? })`

Global rules:

- `get_applicable_rules({ mode?, actions?, paths?, task?, ids?, targetEnvironment?, subjects?, cursor? })`
- `record_rule_attestation({ ruleId, ruleBodyHash, subject, outcome, evidence })`

`find_memories` accepts optional `lifecycleStatus: "current" | "superseded" | "retracted" | "all"`. When omitted, promoted results remain current-only; candidates are unchanged. It also accepts optional `layer: "core" | "device" | "branch" | "all"` and reports each memory's layer; when omitted, every layer is returned. Results include `reviewToken`, the latest `review`, `trust.displayStatus`, and `confidenceBasis`. Pass that token to `resolve_memory_review`; stale tokens are rejected when the memory, evidence, related-file commits, or conflicts changed. Verify preserves numeric extraction confidence and candidate/promotion state, Correct creates a human-authored replacement, and Discard retains the original for audit. `remember_project_memory` accepts optional `layer`; promoted writes default to shared `core`, while `promote: false` defaults to `branch:<name>:device:<installation-id>` when the configured Git repo is on a non-default branch. `suggest_memory_layer_promotions` is read-only and returns suggested promotion actions for non-core durable memories that pass conservative confidence and scope checks; branch candidate suggestions use `resolve_branch_memory_triage` because that path promotes the candidate into a durable `core` memory. `suggest_branch_memory_triage` groups branch-layer memories by Git branch state and hides unchanged reviewed items by default. `explain_memory_promotions` is read-only and reports both what automatic promotion would do now and what it already decided, with privacy-safe reason codes; after each sync Butler applies only unambiguous promotions, converges exact duplicates onto the existing core fact, defers contradictions as `needs_review`, and honours an explicit `retain_branch` or `discard` review over its own policy. Candidates already in `core` are promoted when a person verified them (desktop or CLI, no confidence bar), their evidence spans two independent sources (confidence ≥ `promotion.confidenceThreshold`), or an AI review judged them current, excluding replacements that review wrote itself (confidence ≥ `promotion.automatic.singleSourceMinConfidence`, default 0.90); `resolve_memory_review` verification from MCP does not count, and MCP can still verify only memories that need review. Turn that off with `promotion.automatic.coreCandidates: false`. Disable it with `promotion.automatic.enabled: false`. `resolve_branch_memory_triage` explicitly `promote_to_core`, `discard`, or `retain_branch` for reviewed branch memories. `update_memory_layer` moves an existing memory between layers and accepts `device` as an alias for this installation's device layer. `remember_project_memory` accepts `supersedesMemoryId` for promoted replacements. `update_memory_status` requires a nonempty `memoryId`, lifecycle `status`, and `reason`; `superseded` also requires `replacementMemoryId`.

`list_source_failures` accepts optional `adapter`, `resolved`, and bounded `limit` filters. Messages are sanitized and never include raw parser lines. Repairing and successfully reparsing a source resolves its persisted failures automatically.

Search is FTS-only by default. With optional hybrid retrieval configured, `search_project_memory` and `find_memories` may add `ranking.lexicalRank`, `ranking.semanticRank`, and `ranking.fusedScore` to ranked results. Existing fields and required parameters are unchanged. If semantic ranking is unavailable for any reason, the MCP response is exactly the FTS response and contains no ranking metadata.

Embedding setup and queue management use the CLI (`code-butler embeddings build` and `code-butler embeddings status`); there is no MCP embeddings tool. Remote embedding endpoints require explicit privacy opt-in and always receive redacted text. Code Butler never automatically falls back to a remote endpoint.

## Recommended Agent Flow

Start by syncing memory and reading the project brief. When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write the SQLite database directly. When a fact changes, supersede it with a current replacement; retract it when it was invalid and has no replacement. Use `code-butler memory conflicts` for a dry-run review of current-memory conflicts and `--fix` only when the proposed relation and quality changes are appropriate. For continuation questions, summarize active context first. For file-specific questions, use code-change explanation and project memory search before editing.

## See Also

[Architecture](./architecture.md) — retrieval, project summaries, memory scope, layers, and review.
