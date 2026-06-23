# Code Butler

Code Butler is a local-first Project Memory MCP server. It helps coding agents
and developers reconstruct why a project changed by indexing local evidence
such as Git commits, Codex sessions, Claude Code sessions, and manual decision
records.

The server exposes that memory through MCP tools for project summaries,
searching decisions and constraints, explaining file history, and investigating
recent changes. Project memory stays local by default in each repository's
`.code-butler/` directory.

## Requirements

- Node.js 24 or newer
- Git

## Install And Build

```bash
npm install
npm run build
```

The compiled CLI is available at:

```text
dist/cli.js
```

During development you can run the TypeScript entrypoint directly:

```bash
npx tsx src/cli.ts --help
```

## CLI Usage

Initialize Code Butler memory for a project:

```bash
node dist/cli.js init
```

Run an incremental sync:

```bash
node dist/cli.js sync
node dist/cli.js sync --source git
```

Inspect configured sources:

```bash
node dist/cli.js sources status
```

Refresh the project narrative summary:

```bash
node dist/cli.js project-summary refresh
```

## MCP Usage

Build the project first:

```bash
npm run build
```

Then configure your MCP client to launch:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp
```

`code-butler mcp` resolves the current Git repository and creates project-local
memory storage on first launch. If the MCP client starts outside the target
repository, pass an explicit project root:

```bash
node /absolute/path/to/code-butler/dist/cli.js mcp --project-root /absolute/path/to/project
```

## Project-Local Memory

Code Butler stores state under `.code-butler/` in the project being indexed.
That directory can include config files, SQLite databases, sync cursors,
conversation imports, and generated project summaries.

Keep real local state private:

- Do not commit `.code-butler/config.json` if it contains machine-specific
  paths or settings.
- Do not commit `.code-butler/.env` or any API keys.
- Do not commit `.code-butler/memory.sqlite` or imported conversation logs.
- Use generated example config files as references only.

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
