import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addDecision } from "../src/decisions/store.js";
import { createRedactionPolicy } from "../src/privacy/policy.js";
import { deletePrivacySource } from "../src/privacy/service.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { hashOperationIdentifier } from "../src/operations/log.js";
import { openMemoryStore } from "../src/storage/store.js";

describe("privacy delete", () => {
  it("deletes source-owned data, removes matching evidence, retracts evidence-free memories, and tombstones the source", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-delete-"));
    const store = openMemoryStore(rootDir);
    store.init();
    addSource(store, "delete-me");
    addSource(store, "keep-me");
    const retainedCandidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Retained",
      summary: "Has another source",
      reason: "Evidence",
      confidence: 0.9,
      evidence: [
        { sourceType: "conversation", sourceId: "delete-me", locator: "delete-me:chunk:0" },
        { sourceType: "conversation", sourceId: "keep-me", locator: "keep-me:chunk:0" }
      ],
      relatedFiles: [],
      dedupeKey: "retained-memory"
    });
    const retained = store.promoteMemoryCandidate(retainedCandidate.id);
    const retractedCandidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Retracted",
      summary: "Only deleted evidence",
      reason: "Evidence",
      confidence: 0.9,
      evidence: [{ sourceType: "conversation", sourceId: "delete-me", locator: "delete-me:chunk:0" }],
      relatedFiles: [],
      dedupeKey: "retracted-memory"
    });
    const retracted = store.promoteMemoryCandidate(retractedCandidate.id);

    const result = deletePrivacySource(store, {
      sourceId: "delete-me",
      confirmSourceId: "delete-me"
    });

    expect(existsSync(result.backupPath)).toBe(false);
    expect(store.readSource("delete-me")).toBeUndefined();
    expect(store.search({ query: "deletebody", limit: 10 })).toEqual([]);
    expect(store.listMemoryCandidates({ limit: null }).map(({ id }) => id))
      .not.toContain(retractedCandidate.id);
    expect(store.readMemory(retained.id)).toMatchObject({
      lifecycleStatus: "current",
      evidence: [{ sourceType: "conversation", sourceId: "keep-me", locator: "keep-me:chunk:0" }]
    });
    expect(store.readMemory(retracted.id)).toMatchObject({
      lifecycleStatus: "retracted",
      evidence: [],
      statusReason: "Evidence deleted by privacy operation"
    });
    expect(store.findSourceTombstone("conversation", "delete-me")).toBeTruthy();

    store.addSourceWithChunks({
      source: {
        id: "delete-me",
        type: "conversation",
        title: "resurrected",
        origin: "codex",
        rawContent: "resurrected"
      },
      chunks: [{ text: "resurrected" }]
    });
    expect(store.readSource("delete-me")).toBeUndefined();
    store.close();
  });

  it("requires exact confirmation before creating a backup or mutating", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-delete-confirm-"));
    const store = openMemoryStore(rootDir);
    store.init();
    addSource(store, "delete-me");

    expect(() => deletePrivacySource(store, {
      sourceId: "delete-me",
      confirmSourceId: "wrong"
    })).toThrow("Confirmation must exactly match source ID");
    expect(store.readSource("delete-me")).toBeTruthy();
    expect(store.findSourceTombstone("conversation", "delete-me")).toBeUndefined();
    store.close();
  });

  it("does not recreate a manual memory candidate after its stable source is tombstoned", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-manual-tombstone-"));
    const store = openMemoryStore(rootDir);
    store.init();
    const input = {
      type: "constraint" as const,
      text: "Always keep this stable manual memory.",
      promote: true
    };
    const first = rememberProjectMemory(store, input);
    deletePrivacySource(store, {
      sourceId: first.sourceId,
      confirmSourceId: first.sourceId
    });

    expect(() => rememberProjectMemory(store, input)).toThrow("Memory rejected by quality gate");
    expect(store.readSource(first.sourceId)).toBeUndefined();
    expect(store.listMemoryCandidates({ limit: null })).toEqual([]);
    store.close();
  });

  it("does not reuse a deleted decision ID or leave its durable memory current", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-decision-tombstone-"));
    const store = openMemoryStore(rootDir);
    store.init();
    const first = addDecision(store, {
      topic: "First decision",
      decision: "Use the first approach.",
      reason: "Initial choice.",
      status: "accepted",
      evidence: []
    });
    deletePrivacySource(store, {
      sourceId: first.id,
      confirmSourceId: first.id
    });

    const second = addDecision(store, {
      topic: "Second decision",
      decision: "Use the second approach.",
      reason: "Replacement choice.",
      status: "accepted",
      evidence: []
    });

    expect(first.id).toBe("DEC-0001");
    expect(second.id).toBe("DEC-0002");
    expect(store.readSource(first.id)).toBeUndefined();
    expect(store.readMemory(`memory-manual-${first.id}`)).toMatchObject({
      lifecycleStatus: "retracted",
      statusReason: "Evidence deleted by privacy operation"
    });
    expect(store.readMemory(`memory-manual-${second.id}`)).toMatchObject({
      lifecycleStatus: "current"
    });
    store.close();
  });

  it("uses one canonical tombstone identity for configured secret-bearing source IDs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "code-butler-privacy-canonical-tombstone-"));
    const secret = "project-source-secret";
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "source secret", kind: "literal", pattern: secret }]
    });
    const store = openMemoryStore(rootDir, { privacyPolicy: policy });
    store.init();
    const rawSourceId = `conversation-${secret}`;
    const storedSourceId = store.addSourceWithChunks({
      source: {
        id: rawSourceId,
        type: "conversation",
        title: "Secret identity source",
        origin: "codex",
        rawContent: "Body"
      },
      chunks: [{ text: "Body" }]
    });

    const result = deletePrivacySource(store, {
      sourceId: storedSourceId,
      confirmSourceId: storedSourceId
    });

    expect(result.sourceIdHash).toBe(hashOperationIdentifier(storedSourceId));
    expect(store.findSourceTombstone("conversation", rawSourceId)).toBeTruthy();
    store.addSourceWithChunks({
      source: {
        id: rawSourceId,
        type: "conversation",
        title: "Attempted resurrection",
        origin: "codex",
        rawContent: "Resurrected"
      },
      chunks: [{ text: "Resurrected" }]
    });
    expect(store.readSource(storedSourceId)).toBeUndefined();
    store.close();
  });
});

function addSource(store: ReturnType<typeof openMemoryStore>, id: string): void {
  store.addSourceWithChunks({
    source: {
      id,
      type: "conversation",
      title: id,
      origin: "codex",
      rawContent: id === "delete-me" ? "deletebody" : "keepbody"
    },
    chunks: [{ text: id === "delete-me" ? "deletebody" : "keepbody" }]
  });
}
