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

The MCP server exposes 20 tools. Lifecycle-related calls include:

- `sync_project_memory`
- `summarize_project_brief`
- `summarize_active_context`
- `search_temporary_memory`
- `search_project_memory`
- `find_memories`
- `remember_project_memory`
- `update_memory_status`
- `explain_code_change`
- `investigate_project_history`
- `summarize_recent_activity`

`find_memories` accepts optional `lifecycleStatus: "current" | "superseded" | "retracted" | "all"`. When omitted, promoted results remain current-only; candidates are unchanged. `remember_project_memory` accepts `supersedesMemoryId` for promoted replacements. `update_memory_status` requires a nonempty `memoryId`, lifecycle `status`, and `reason`; `superseded` also requires `replacementMemoryId`.

Search is FTS-only by default. With optional hybrid retrieval configured, `search_project_memory` and `find_memories` may add `ranking.lexicalRank`, `ranking.semanticRank`, and `ranking.fusedScore` to ranked results. Existing fields and required parameters are unchanged. If semantic ranking is unavailable for any reason, the MCP response is exactly the FTS response and contains no ranking metadata.

Embedding setup and queue management use the CLI (`code-butler embeddings build` and `code-butler embeddings status`); there is no MCP embeddings tool. Remote embedding endpoints require explicit privacy opt-in and always receive redacted text. Code Butler never automatically falls back to a remote endpoint.

## Recommended Agent Flow

Start by syncing memory and reading the project brief. When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write the SQLite database directly. When a fact changes, supersede it with a current replacement; retract it when it was invalid and has no replacement. Use `code-butler memory conflicts` for a dry-run review of current-memory conflicts and `--fix` only when the proposed relation and quality changes are appropriate. For continuation questions, summarize active context first. For file-specific questions, use code-change explanation and project memory search before editing.

## See Also

[Architecture overview](/architecture.html) — full system diagram with pipeline stages, layer stack, and data flows.
