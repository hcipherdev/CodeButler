// Tests readExtractedMemories() in src/extract/parse.ts: sameAs and invalidates references, and the bug_fix-needs-a-fix rule.
import { describe, expect, it } from "vitest";

import { readExtractedMemories } from "../../src/extract/parse.js";
import type { ExtractorContext } from "../../src/types.js";

const context: ExtractorContext = {
  conversations: [],
  commits: [{ hash: "abc123", authorName: "T", authorEmail: "t@example.com", authoredAt: "2026-10-05T00:00:00Z", message: "Fix", changedFiles: [], diffSummary: "" }],
  existingMemories: [{ ref: "E1", type: "bug_fix", title: "t", summary: "s", status: "durable", recordedAt: "2026-10-01T00:00:00Z" }]
};
const record = (extra: Record<string, unknown>) => ({
  type: "decision", title: "Trust on recovery", summary: "Recovery codes grant trust.", reason: "Fixed.", confidence: 0.9,
  dedupeKey: "trust", relatedFiles: [], evidence: [{ sourceType: "commit", sourceId: "abc123" }], ...extra
});

describe("readExtractedMemories", () => {
  it("keeps well-formed sameAs and invalidates references", () => {
    const [memory] = readExtractedMemories({ memories: [record({ sameAs: " E2 ", invalidates: { ref: "E1", confidence: 0.95, why: " Fixed later. " } })] }, context).memories;
    expect(memory?.sameAs).toBe("E2");
    expect(memory?.invalidates).toEqual({ ref: "E1", confidence: 0.95, why: "Fixed later." });
  });

  it("drops malformed references but keeps the memory", () => {
    const result = readExtractedMemories({ memories: [record({ sameAs: "memory-123", invalidates: { ref: "E1", confidence: 2 } })] }, context);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).not.toHaveProperty("sameAs");
    expect(result.memories[0]).not.toHaveProperty("invalidates");
  });

  it("rejects a bug_fix that states no fix and keeps one that does", () => {
    const bug = (fields: Record<string, string>) => record({
      type: "bug_fix", title: "Recovery code now grants device trust",
      statement: { version: 1, text: "Recovery codes grant trust.", origin: "extracted", fields }
    });
    const result = readExtractedMemories({ memories: [bug({ symptom: "Device stays untrusted." }), bug({ symptom: "Device stays untrusted.", fix: "Record recovery as trust evidence." })] }, context);
    expect(result.rejected).toEqual([{ index: 0, reason: "bug_fix_without_fix" }]);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.statement?.fields.fix).toBe("Record recovery as trust evidence.");
  });
});
