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

Agents can call tools such as:

- `sync_project_memory`
- `summarize_project_brief`
- `summarize_active_context`
- `search_temporary_memory`
- `search_project_memory`
- `find_memories`
- `remember_project_memory`
- `explain_code_change`
- `investigate_project_history`
- `summarize_recent_activity`

## Recommended Agent Flow

Start by syncing memory and reading the project brief. When the user asks to remember, save, or note a project memory, call `current_project`, then `remember_project_memory`, then verify with `find_memories`; do not inspect or write the SQLite database directly. For continuation questions, summarize active context first. For file-specific questions, use code-change explanation and project memory search before editing.

## See Also

[Architecture overview](/architecture.html) — full system diagram with pipeline stages, layer stack, and data flows.
