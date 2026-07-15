# Code Butler

Code Butler gives coding agents a local-first project memory they can use before editing code.

It indexes evidence from Git commits, Codex sessions, Claude sessions, manual decisions, and project summaries. Then it exposes that context through MCP tools so an agent can answer questions such as:

- Why did this file change?
- What constraints matter before editing this area?
- Where did the last coding session leave off?
- Which decision led to the current implementation?
- Did the project already reject another approach?

Project memory stays local by default in each repository's `.code-butler/` directory.

Search is local SQLite FTS by default. Projects may opt into hybrid lexical/semantic ranking through an explicitly configured OpenAI-compatible embedding endpoint; FTS remains the exact fallback and remote use requires explicit privacy permission with mandatory redaction.

## What Code Butler Adds

Git explains what changed. Chat logs explain pieces of why. Agent instruction files explain what future agents should do. Code Butler connects those sources into a searchable project memory layer.

Use it when you want agents to start from project evidence instead of guessing from the current files alone.

## Memory Layers

Code Butler uses three layers:

- Temporary working context for recent Codex and Claude activity.
- Candidate memories extracted from project evidence.
- Durable memories for accepted decisions, constraints, bug fixes, and rejected approaches.

## Start Here

- [Quick Start](./quickstart.md)
- [MCP Setup](./mcp-setup.md)
- [Architecture and retrieval](./architecture.html)
- [Public Sync](./public-sync.md)
