import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectMemoryToolHandlers } from "../tools.js";
import { asJsonContent, compactOptionalInput } from "./shared.js";

export function registerSourceToolGroup(
  server: McpServer,
  handlers: ProjectMemoryToolHandlers
): void {
  server.registerTool("current_project", {
    description: "Report which project-local Code Butler store this MCP server is using.",
    inputSchema: {}
  }, async () => asJsonContent(handlers.current_project()));

  server.registerTool("search_project_memory", {
    description: "Search local project memory. Promoted memories are returned ahead of raw source matches.",
    inputSchema: {
      query: z.string().min(1),
      sourceTypes: z.array(z.enum(["conversation", "commit", "decision"])).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(await handlers.search_project_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["search_project_memory"]>[0]>(input)
  )));

  server.registerTool("read_memory_source", {
    description: "Read the raw stored source for a memory source id.",
    inputSchema: { sourceId: z.string().min(1) }
  }, async (input) => asJsonContent(handlers.read_memory_source(input)));

  server.registerTool("find_decisions", {
    description: "Find project decisions from manual records and promoted decision memories.",
    inputSchema: {
      topic: z.string().optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(handlers.find_decisions(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["find_decisions"]>[0]>(input)
  )));

  server.registerTool("find_related_commits", {
    description: "Find ingested Git commits by query or changed file path.",
    inputSchema: {
      query: z.string().optional(),
      filePath: z.string().optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(handlers.find_related_commits(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["find_related_commits"]>[0]>(input)
  )));

  server.registerTool("sync_project_memory", {
    description: "Run an incremental sync from configured Git, Codex, and Claude sources.",
    inputSchema: { source: z.enum(["git", "codex", "claude", "all"]).optional() }
  }, async (input) => asJsonContent(await handlers.sync_project_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["sync_project_memory"]>[0]>(input)
  )));

  server.registerTool("summarize_project_state", {
    description: "Summarize the current local project memory index and sync state.",
    inputSchema: {}
  }, async () => asJsonContent(handlers.summarize_project_state()));

  server.registerTool("list_source_failures", {
    description: "List persisted source parsing failures and their repair status.",
    inputSchema: {
      adapter: z.enum(["git", "codex", "claude"]).optional(),
      resolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  }, async (input) => asJsonContent(handlers.list_source_failures(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["list_source_failures"]>[0]>(input)
  )));

  server.registerTool("run_doctor", {
    description: "Run a read-only Code Butler health check for the current project.",
    inputSchema: {}
  }, async () => asJsonContent(handlers.run_doctor()));

  server.registerTool("summarize_project_brief", {
    description: "Read the local project narrative summary and freshness metadata without mutating files.",
    inputSchema: {}
  }, async () => asJsonContent(await handlers.summarize_project_brief()));

  server.registerTool("refresh_project_summary", {
    description: "Refresh the local project narrative summary without rewriting AGENTS.md or CLAUDE.md.",
    inputSchema: { force: z.boolean().optional() }
  }, async (input) => asJsonContent(await handlers.refresh_project_summary(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["refresh_project_summary"]>[0]>(input)
  )));
}
