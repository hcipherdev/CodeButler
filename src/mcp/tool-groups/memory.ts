import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectMemoryToolHandlers } from "../tools.js";
import { asJsonContent, compactOptionalInput } from "./shared.js";

const memoryType = z.enum(["decision", "bug_fix", "constraint", "rejected_approach"]);

export function registerMemoryToolGroup(
  server: McpServer,
  handlers: ProjectMemoryToolHandlers
): void {
  server.registerTool("find_memories", {
    description: "Find promoted or candidate durable project memories.",
    inputSchema: {
      query: z.string().optional(),
      type: memoryType.optional(),
      status: z.enum(["promoted", "candidate"]).optional(),
      qualityStatus: z.enum(["active", "needs_review", "quarantined", "all"]).optional(),
      lifecycleStatus: z.enum(["current", "superseded", "retracted", "all"]).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async (input) => asJsonContent(await handlers.find_memories(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["find_memories"]>[0]>(input)
  )));

  server.registerTool("remember_project_memory", {
    description: "Store an explicit user-requested durable project memory without inspecting local database internals.",
    inputSchema: {
      type: memoryType,
      text: z.string().min(1),
      title: z.string().min(1).optional(),
      reason: z.string().min(1).optional(),
      relatedFiles: z.array(z.string().min(1)).optional(),
      promote: z.boolean().optional(),
      supersedesMemoryId: z.string().min(1).optional()
    }
  }, async (input) => asJsonContent(handlers.remember_project_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["remember_project_memory"]>[0]>(input)
  )));

  server.registerTool("update_memory_status", {
    description: "Mark a durable memory current, superseded, or retracted while preserving lifecycle history.",
    inputSchema: {
      memoryId: z.string().min(1),
      status: z.enum(["current", "superseded", "retracted"]),
      reason: z.string().trim().min(1),
      replacementMemoryId: z.string().min(1).optional()
    }
  }, async (input) => asJsonContent(handlers.update_memory_status(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["update_memory_status"]>[0]>(input)
  )));

  server.registerTool("summarize_memory_health", {
    description: "Summarize durable memory quality status and top quality-review reasons.",
    inputSchema: {}
  }, async () => asJsonContent(handlers.summarize_memory_health()));
}
