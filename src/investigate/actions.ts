import { z } from "zod";

export const investigationEntitySchema = z.object({
  entityType: z.enum(["source", "chunk", "commit", "decision", "memory", "candidate", "temporary_memory", "file"]),
  entityId: z.string().min(1)
});

const evidenceRefSchema = z.object({
  sourceType: z.enum(["conversation", "commit", "decision"]),
  sourceId: z.string().min(1),
  locator: z.string().optional()
});

export const investigationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search_temporary_memory"),
    query: z.string().min(1),
    threadId: z.string().optional(),
    sessionId: z.string().optional(),
    limit: z.number().int().positive().max(100).optional()
  }),
  z.object({
    type: z.literal("search_memories"),
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
    status: z.enum(["promoted", "candidate"]).optional()
  }),
  z.object({
    type: z.literal("search_raw_sources"),
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
    sourceTypes: z.array(z.enum(["conversation", "commit", "decision"])).optional()
  }),
  z.object({
    type: z.literal("find_related_commits"),
    query: z.string().optional(),
    filePath: z.string().optional(),
    limit: z.number().int().positive().max(100).optional()
  }),
  z.object({
    type: z.literal("read_source"),
    sourceId: z.string().min(1)
  }),
  z.object({
    type: z.literal("read_conversation_window"),
    sourceId: z.string().min(1),
    anchorChunkId: z.string().optional(),
    chunkIndex: z.number().int().min(0).optional(),
    before: z.number().int().min(0).optional(),
    after: z.number().int().min(0).optional()
  }),
  z.object({
    type: z.literal("read_commit"),
    hash: z.string().min(1)
  }),
  z.object({
    type: z.literal("follow_evidence_refs"),
    evidence: z.array(evidenceRefSchema),
    limit: z.number().int().positive().max(100).optional()
  }),
  z.object({
    type: z.literal("expand_entity_links"),
    entity: investigationEntitySchema,
    limit: z.number().int().positive().max(100).optional()
  }),
  z.object({
    type: z.literal("spawn_subinvestigation"),
    question: z.string().min(1),
    targetEntity: investigationEntitySchema.optional()
  }),
  z.object({
    type: z.literal("finalize_answer")
  })
]);

export const investigationPlanDecisionSchema = z.object({
  action: investigationActionSchema,
  rationale: z.string().min(1)
});

export const investigationSynthesisSchema = z.object({
  answer: z.string().min(1),
  evidenceScore: z.number().min(0).max(1)
});
