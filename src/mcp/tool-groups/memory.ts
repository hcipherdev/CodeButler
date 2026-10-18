import { memoryStatementInputSchema, memoryStatementSchema } from "../../memory/statement.js";
import { normalizeScope, memoryScopeSchema, targetEnvironmentSchema, SCOPE_GUIDANCE } from "../../memory/scope.js";
import { memoryLayerSchema, memoryLayerInputSchema, memoryLayerFilterSchema, memoryLayerOwnerSchema, LAYER_GUIDANCE } from "../../memory/layer.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectMemoryToolHandlers } from "../tools.js";
import { asJsonContent, compactOptionalInput } from "./shared.js";

const memoryType = z.enum(["decision", "bug_fix", "constraint", "rejected_approach"]);
const branchTriageCategory = z.enum(["candidate", "promoted"]);
const branchTriageAction = z.enum(["promote_to_core", "discard", "retain_branch"]);
const reviewCategory = z.enum(["candidate", "promoted"]);
const reviewAction = z.enum(["verify", "correct", "discard"]);

export function registerMemoryToolGroup(
  server: McpServer,
  handlers: ProjectMemoryToolHandlers
): void {
  const knowledgeFilter={reach:z.enum(["all","project","device","branch","branch_device"]).optional(),owner:z.enum(["self","peer","any"]).optional()};
  server.registerTool("get_memory_history",{
    description:"Read recorded lifecycle history with predecessor and replacement links, corrections, withdrawal and restoration. Private predecessors remain unavailable from core history.",
    inputSchema:{id:z.string().min(1),category:reviewCategory,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}
  },async input=>asJsonContent(await handlers.get_memory_history(compactOptionalInput<Parameters<ProjectMemoryToolHandlers["get_memory_history"]>[0]>(input))));
  server.registerTool("read_project_handbook",{
    description:"Read confirmed project-memory topics or a topic page. Defaults to current active durable whole-project knowledge; device and branch reach must be selected explicitly. Reading never creates assignments.",
    inputSchema:{...knowledgeFilter,topicId:z.string().min(1).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}
  },async input=>asJsonContent(await handlers.read_project_handbook(compactOptionalInput<NonNullable<Parameters<ProjectMemoryToolHandlers["read_project_handbook"]>[0]>>(input))));
  server.registerTool("summarize_memory_movement",{
    description:"Read made-durable, project-sharing, replacement and withdrawal activity for the rolling last seven days, including partial historical sharing coverage.",inputSchema:knowledgeFilter
  },async input=>asJsonContent(await handlers.summarize_memory_movement(compactOptionalInput<NonNullable<Parameters<ProjectMemoryToolHandlers["summarize_memory_movement"]>[0]>>(input))));
  server.registerTool("find_memories", {
    description: "Find promoted or candidate durable project memories." + SCOPE_GUIDANCE + LAYER_GUIDANCE,
    inputSchema: {
      targetEnvironment: targetEnvironmentSchema.optional(),
      layer: memoryLayerFilterSchema.optional(),
      owner: memoryLayerOwnerSchema.optional(),
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
    description: "Store an explicit user-requested durable project memory without inspecting local database internals. Promoted writes default to the shared core layer; unpromoted candidates default to the current branch/device layer off the default Git branch unless layer is explicit.",
    inputSchema: {
      scope: memoryScopeSchema.optional(),
      layer: memoryLayerSchema.optional(),
      type: memoryType,
      text: z.string().min(1),
      statement: memoryStatementInputSchema.optional(),
      title: z.string().min(1).optional(),
      reason: z.string().min(1).optional(),
      relatedFiles: z.array(z.string().min(1)).optional(),
      promote: z.boolean().optional(),
      supersedesMemoryId: z.string().min(1).optional()
    }
  }, async (input) => asJsonContent(await handlers.remember_project_memory(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["remember_project_memory"]>[0]>(input)
  )));

  server.registerTool("update_memory_scope", {
    description: "Correct memory scope explicitly; requires a reason and preserves generation origin.",
    inputSchema: {
      memoryId: z.string().min(1),
      category: z.enum(["candidate", "promoted", "temporary"]),
      scope: memoryScopeSchema,
      reason: z.string().trim().min(1)
    }
  }, async input => asJsonContent(await handlers.update_memory_scope({ ...input, scope: normalizeScope(input.scope) })));

  server.registerTool("update_memory_layer", {
    description: "Move an existing memory between sync layers explicitly; requires a reason and preserves generation origin.",
    inputSchema: {
      memoryId: z.string().min(1),
      category: z.enum(["candidate", "promoted", "temporary"]),
      layer: memoryLayerInputSchema,
      reason: z.string().trim().min(1)
    }
  }, async input => asJsonContent(await handlers.update_memory_layer(input)));

  server.registerTool("suggest_memory_layer_promotions", {
    description: "Suggest non-core durable memories that may be ready to move to the shared core layer. Read-only preview; sync already applies unambiguous promotions automatically, so use explain_memory_promotions to see what it decided and why.",
    inputSchema: {
      layer: memoryLayerFilterSchema.optional(),
      includeCandidates: z.boolean().optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      minScore: z.number().min(0).max(1).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async input => asJsonContent(await handlers.suggest_memory_layer_promotions(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["suggest_memory_layer_promotions"]>[0]>(input)
  )));

  server.registerTool("suggest_branch_memory_triage", {
    description: "Review branch-layer durable memories by Git branch state. Read-only. Sync automatically promotes unambiguous merged-branch memories; this surface covers the remainder and records explicit decisions.",
    inputSchema: {
      branch: z.string().min(1).max(200).optional(),
      includeActive: z.boolean().optional(),
      staleDays: z.number().int().positive().optional(),
      includeReviewed: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async input => asJsonContent(await handlers.suggest_branch_memory_triage(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["suggest_branch_memory_triage"]>[0]>(input)
  )));

  server.registerTool("resolve_branch_memory_triage", {
    description: "Explicitly promote, discard, or retain a reviewed branch-layer durable memory.",
    inputSchema: {
      memoryId: z.string().min(1),
      category: branchTriageCategory,
      action: branchTriageAction,
      reason: z.string().trim().min(1),
      supersedesMemoryId: z.string().min(1).optional()
    }
  }, async input => asJsonContent(await handlers.resolve_branch_memory_triage(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["resolve_branch_memory_triage"]>[0]>(input)
  )));

  server.registerTool("resolve_memory_review", {
    description: "Persist a human Verify, Correct, or Discard decision for a durable memory. Pass reviewToken from find_memories to reject stale decisions. Correct and Discard require a reason; Verify defaults to confirming current project state.",
    inputSchema: {
      memoryId: z.string().min(1),
      category: reviewCategory,
      action: reviewAction,
      reason: z.string().trim().min(1).optional(),
      reviewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      correction: z.object({
        type: memoryType.optional(),
        title: z.string().trim().min(1).optional(),
        text: z.string().trim().min(1).optional(),
        summary: z.string().trim().min(1).optional(),
        reason: z.string().trim().min(1).optional(),
        relatedFiles: z.array(z.string().trim().min(1)).optional(),
        scope: memoryScopeSchema.optional(),
        statement: memoryStatementSchema.optional()
      }).strict().optional()
    }
  }, async input => asJsonContent(await handlers.resolve_memory_review(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["resolve_memory_review"]>[0]>(input)
  )));

  server.registerTool("explain_memory_promotions", {
    description: "Explain what automatic layer promotion would do now and what it already decided, with privacy-safe reason codes. Read-only.",
    inputSchema: {
      memoryId: z.string().min(1).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async input => asJsonContent(await handlers.explain_memory_promotions(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["explain_memory_promotions"]>[0]>(input)
  )));

  server.registerTool("explain_layer_retention", {
    description: "Explain what layer retention would archive now and what it already archived, with privacy-safe reason codes. Read-only; retention never touches core memories.",
    inputSchema: {
      memoryId: z.string().min(1).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async input => asJsonContent(await handlers.explain_layer_retention(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["explain_layer_retention"]>[0]>(input)
  )));

  server.registerTool("update_memory_status", {
    description: "Mark a durable memory current, superseded, or retracted while preserving lifecycle history.",
    inputSchema: {
      memoryId: z.string().min(1),
      status: z.enum(["current", "superseded", "retracted"]),
      reason: z.string().trim().min(1),
      replacementMemoryId: z.string().min(1).optional()
    }
  }, async (input) => asJsonContent(await handlers.update_memory_status(
    compactOptionalInput<Parameters<ProjectMemoryToolHandlers["update_memory_status"]>[0]>(input)
  )));

  server.registerTool("summarize_memory_health", {
    description: "Summarize durable memory quality status and top quality-review reasons.",
    inputSchema: {}
  }, async () => asJsonContent(await handlers.summarize_memory_health()));
}
