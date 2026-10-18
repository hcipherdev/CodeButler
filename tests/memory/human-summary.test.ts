// Tests memory-derived human summaries, eligibility, stable fingerprints, and legacy format refresh.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { gitExecutable } from "../../src/git-executable.js";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openMemoryStore } from "../../src/storage/store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { createStatement } from "../../src/memory/statement.js";
import { readAgentContext } from "../../src/project-summary/agent-guidance.js";
import { assembleHumanSummary, selectSummaryMemories } from "../../src/project-summary/memory-sections.js";
import { collectProjectSummaryInput, refreshProjectSummary, getProjectSummaryStatus } from "../../src/project-summary/service.js";
import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import { publishRetrieval, readPublishedSummary, closeRetrievalReaders } from "../../src/retrieval/index.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const stores: ReturnType<typeof openMemoryStore>[] = [], roots: string[] = [];
afterEach(() => { closeRetrievalReaders(); for (const s of stores.splice(0))
    s.close(); for (const r of roots.splice(0))
    cleanupTempDir(r); });
function fixture() { const root = makeTempDir(); roots.push(root); ensureProjectConfig(root); const store = openMemoryStore(root); store.init(); stores.push(store); return { root, store, config: loadProjectConfig(root) }; }
describe("human summary", () => {
    it("owns decision/constraint prose, preserves conditional applicability, and includes every eligible memory", () => {
        const { store } = fixture();
        for (let i = 0; i < 55; i++)
            rememberProjectMemory(store, { type: "decision", text: "Use recorded project choice " + i + ".", scope: { kind: "project" } });
        const constraint = rememberProjectMemory(store, { type: "constraint", text: "Never commit signing keys.", scope: { kind: "conditional", platforms: ["win32"] },
            statement: { fields: { requirement: "Never commit signing keys.", rationale: "Keep package signing local." } } }).memory!;
        rememberProjectMemory(store, { type: "decision", text: "Use a branch-specific prototype.", layer: "branch:prototype", scope: { kind: "project" } });
        rememberProjectMemory(store, { type: "decision", text: "Evaluate another prototype.", promote: false, scope: { kind: "project" } });
        const old = rememberProjectMemory(store, { type: "decision", text: "Use the retired sync format.", scope: { kind: "project" } }).memory!;
        store.updateMemoryLifecycle(old.id, { lifecycleStatus: "superseded" });
        const memories = selectSummaryMemories(store);
        expect(memories).toHaveLength(56);
        const summary = assembleHumanSummary(memories, "## What this is\nA project.\n## Key decisions\nInvented decision.\n## Agent Usage\nAgent tool list.\n## Open risks and questions\nAn unresolved risk.");
        expect(summary).toContain("Use recorded project choice 54.");
        expect(summary).toContain("Never commit signing keys.");
        expect(summary).toContain("applies when: Windows");
        expect(summary).toContain("(memory:" + encodeURIComponent(constraint.id) + ")");
        expect(summary).not.toContain("Invented decision");
        expect(summary).not.toContain("Agent tool list");
        expect(summary).not.toContain("branch-specific");
        expect(summary).not.toContain("retired sync");
        expect(summary).toContain("An unresolved risk.");
    });
    it("matches published summary freshness and changes its fingerprint when structured rationale changes", async () => {
        const { root, store, config } = fixture();
        const saved = rememberProjectMemory(store, { type: "decision", text: "Use local project storage.", scope: { kind: "project" }, statement: { fields: { rationale: "Support offline work." } } });
        await refreshProjectSummary(store, config, { generator: { generate: async () => "## What this is\nA local memory project." } });
        const before = collectProjectSummaryInput(store, config).fingerprint;
    expect(readAgentContext(root, store).runtime?.summaryStatus?.stale).toBe(false);
    expect(readAgentContext(root, store).runtime?.tiers).toMatchObject({ durable: 1 });
        publishRetrieval(store, root, "fixture");
        expect(readPublishedSummary(root).status?.currentFingerprint).toBe(before);
        expect(readPublishedSummary(root).status?.stale).toBe(false);
        expect(readAgentContext(root).runtime?.tiers).toMatchObject({ durable: 1, candidates: 0 });
        expect(readAgentContext(root).agentGuidance).toContain("get_applicable_rules");
        store.db.prepare("update memories set statement_json=? where id=?").run(JSON.stringify(createStatement(saved.memory!.summary, "decision", "submitted", { rationale: "Support offline collaboration." })), saved.memory!.id);
        expect(collectProjectSummaryInput(store, config).fingerprint).not.toBe(before);
        publishRetrieval(store, root, "fixture");
        expect(readPublishedSummary(root).status?.currentFingerprint).toBe(collectProjectSummaryInput(store, config).fingerprint);
        expect(readPublishedSummary(root).status?.stale).toBe(true);
    });
    it("keeps file context from local current memories while matching published fingerprints", async () => {
        const { root, store, config } = fixture();
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "storage.ts"), "export const storage = true;\n");
        execFileSync(gitExecutable(), ["init", "-q"], { cwd: root });
        execFileSync(gitExecutable(), ["add", "src/storage.ts"], { cwd: root });
        rememberProjectMemory(store, {
            type: "bug_fix", text: "Persist storage before shutdown.", layer: "branch:storage",
            relatedFiles: ["src/storage.ts"], scope: { kind: "project" }
        });
        await refreshProjectSummary(store, config, { generator: { generate: async () => "## What this is\nLocal storage." } });
        const input = collectProjectSummaryInput(store, config);
        expect(input.codeContext.memories).toHaveLength(0);
        expect(input.codeContext.codeFiles.map(file => file.path)).toEqual(["src/storage.ts"]);
        publishRetrieval(store, root, "fixture");
        expect(readPublishedSummary(root).status?.currentFingerprint).toBe(input.fingerprint);
        expect(readPublishedSummary(root).status?.stale).toBe(false);
    });
    it("refreshes old format metadata even with no eligible memories while retaining manual-edit protection", async () => {
        const { root, store, config } = fixture();
        let calls = 0;
        const generator = { generate: async () => { calls++; return "## What this is\nA small project."; } };
        await refreshProjectSummary(store, config, { generator });
        const path = join(root, ".code-butler", "project-summary.meta.json");
        const meta = JSON.parse(readFileSync(path, "utf8"));
        delete meta.format;
        writeFileSync(path, JSON.stringify(meta));
        expect(getProjectSummaryStatus(root, { store, config }).stale).toBe(true);
        await refreshProjectSummary(store, config, { generator });
        expect(calls).toBe(2);
        const summary = join(root, ".code-butler", "project-summary.md");
        writeFileSync(summary, "Maintainer wording.\n");
        const result = await refreshProjectSummary(store, config, { generator });
        expect(result.skippedReason).toBe("manual_edits_detected");
        expect(readFileSync(summary, "utf8")).toBe("Maintainer wording.\n");
    });
});
