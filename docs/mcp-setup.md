# MCP Setup

Configure your MCP client to launch Code Butler with `npx`:

```bash
npx -y code-butler mcp --project-root /absolute/path/to/project
```

Or use a global install:

```bash
code-butler mcp --project-root /absolute/path/to/project
```

The MCP server resolves the target Git repository and creates internal project-local memory storage on first launch. It does not create visible bootstrap files or a project summary; run `code-butler init` when you want that explicit setup.

## Common Tools

The MCP server exposes 28 tools. Lifecycle and operations calls include:

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
- `explain_memory_promotions({ memoryId?, limit? })`
- `update_memory_status`
- `explain_code_change`
- `investigate_project_history`
- `summarize_recent_activity`

`find_memories` accepts optional `lifecycleStatus: "current" | "superseded" | "retracted" | "all"`. When omitted, promoted results remain current-only; candidates are unchanged. It also accepts optional `layer: "core" | "device" | "branch" | "all"` and reports each memory's layer; when omitted, every layer is returned. `remember_project_memory` accepts optional `layer`; promoted writes default to shared `core`, while `promote: false` defaults to `branch:<name>:device:<installation-id>` when the configured Git repo is on a non-default branch. `suggest_memory_layer_promotions` is read-only and returns suggested promotion actions for non-core durable memories that pass conservative confidence and scope checks; branch candidate suggestions use `resolve_branch_memory_triage` because that path promotes the candidate into a durable `core` memory. `suggest_branch_memory_triage` groups branch-layer memories by Git branch state and hides unchanged reviewed items by default. `explain_memory_promotions` is read-only and reports both what automatic promotion would do now and what it already decided, with privacy-safe reason codes; after each sync Butler applies only unambiguous promotions, converges exact duplicates onto the existing core fact, defers contradictions as `needs_review`, and honours an explicit `retain_branch` or `discard` review over its own policy. Disable it with `promotion.automatic.enabled: false`. `resolve_branch_memory_triage` explicitly `promote_to_core`, `discard`, or `retain_branch` for reviewed branch memories. `update_memory_layer` moves an existing memory between layers and accepts `device` as an alias for this installation's device layer. `remember_project_memory` accepts `supersedesMemoryId` for promoted replacements. `update_memory_status` requires a nonempty `memoryId`, lifecycle `status`, and `reason`; `superseded` also requires `replacementMemoryId`.

`list_source_failures` accepts optional `adapter`, `resolved`, and bounded `limit` filters. Messages are sanitized and never include raw parser lines. Repairing and successfully reparsing a source resolves its persisted failures automatically.

Search is FTS-only by default. With optional hybrid retrieval configured, `search_project_memory` and `find_memories` may add `ranking.lexicalRank`, `ranking.semanticRank`, and `ranking.fusedScore` to ranked results. Existing fields and required parameters are unchanged. If semantic ranking is unavailable for any reason, the MCP response is exactly the FTS response and contains no ranking metadata.

Embedding setup and queue management use the CLI (`code-butler embeddings build` and `code-butler embeddings status`); there is no MCP embeddings tool. Remote embedding endpoints require explicit privacy opt-in and always receive redacted text. Code Butler never automatically falls back to a remote endpoint.

## Recommended Agent Flow

Start by syncing memory and reading the project brief. When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write the SQLite database directly. When a fact changes, supersede it with a current replacement; retract it when it was invalid and has no replacement. Use `code-butler memory conflicts` for a dry-run review of current-memory conflicts and `--fix` only when the proposed relation and quality changes are appropriate. For continuation questions, summarize active context first. For file-specific questions, use code-change explanation and project memory search before editing.

## See Also

[Architecture overview](/architecture.html) — full system diagram with pipeline stages, layer stack, and data flows.
