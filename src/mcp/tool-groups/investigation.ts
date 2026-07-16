import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectMemoryToolHandlers } from "../tools.js";
import { asJsonContent, compactOptionalInput } from "./shared.js";

export function registerInvestigationToolGroup(
  server: McpServer,
  handlers: ProjectMemoryToolHandlers
): void {
  server.registerTool("explain_code_change", {
    description: "Explain why a file changed using promoted memories, commits, conversations, and decisions.",
    inputSchema: {
      filePath: z.string().min(1),
      lineNumber: z.number().int().positive().optional(),
      question: z.string().optional()
    }
  }, async (input) => asJsonContent(await handlers.explain_code_change(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["explain_code_change"]>[0]>(input)
  )));

  server.registerTool("investigate_project_history", {
    description: "Run a local multi-step project history investigation for a natural language question.",
    inputSchema: {
      question: z.string().min(1),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(await handlers.investigate_project_history(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["investigate_project_history"]>[0]>(input)
  )));

  server.registerTool("summarize_recent_activity", {
    description:
      "Summarize recent project activity from timestamped Code Butler sources first, with optional Git working-tree corroboration.",
    inputSchema: {
      since: z.string().optional(),
      until: z.string().optional(),
      includeWorkingTree: z.boolean().optional()
    }
  }, async (input) => asJsonContent(handlers.summarize_recent_activity(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["summarize_recent_activity"]>[0]>(input)
  )));

  server.registerTool("search_temporary_memory", {
    description:
      "Search unexpired temporary working context for this project. Results are prioritized for the current thread/session.",
    inputSchema: {
      query: z.string().min(1),
      threadId: z.string().optional(),
      sessionId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(handlers.search_temporary_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["search_temporary_memory"]>[0]>(input)
  )));

  server.registerTool("summarize_active_context", {
    description:
      "Summarize unexpired temporary working context for continuation after compaction or a new agent turn.",
    inputSchema: {
      threadId: z.string().optional(),
      sessionId: z.string().optional(),
      projectOnly: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(handlers.summarize_active_context(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["summarize_active_context"]>[0]>(input)
  )));

  server.registerTool("cleanup_temporary_memory", {
    description: "Delete expired temporary working context, or all temporary context when expiredOnly is false.",
    inputSchema: { expiredOnly: z.boolean().optional() }
  }, async (input) => asJsonContent(handlers.cleanup_temporary_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["cleanup_temporary_memory"]>[0]>(input)
  )));
}
