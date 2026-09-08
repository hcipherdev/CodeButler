import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeScope, inferScope, scopeKey, assessApplicability, scopesDisjoint } from "../src/memory/scope.js";
import { updateMemoryScope } from "../src/memory/scope-service.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import { exportPrivacy, importPrivacy, scrubPrivacy } from "../src/privacy/service.js";
import { initializeSchema, SCHEMA_MIGRATIONS } from "../src/storage/migrations.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import { createOpenAICompatibleExtractor } from "../src/extract/openai.js";
import { runCli } from "../src/cli.js";
import type { MemoryScope, ExtractedMemory } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";
const roots: string[] = [], stores: MemoryStore[] = [];
function root() { const r = makeTempDir(); roots.push(r); return r; }
function store() { const s = openMemoryStore(root()); s.init(); stores.push(s); return s; }
const windows: MemoryScope = { kind: "conditional", platforms: ["Windows"] };
const linux: MemoryScope = { kind: "conditional", platforms: ["linux"] };
const mem = (scope?: MemoryScope): ExtractedMemory => ({ ...(scope ? { scope } : {}), type: "decision", title: "Watcher", summary: "Use polling for file watching.", reason: "Native notifications fail.", confidence: 1, dedupeKey: "watcher", evidence: [], relatedFiles: [] });
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.unstubAllEnvs(); roots.splice(0).forEach(cleanupTempDir); });
it("normalizes aliases, canonicalizes lists and rejects malformed scope", () => {
 expect(normalizeScope({ kind: "conditional", platforms: ["macOS", "darwin"], architectures: ["AMD64"], shells: ["pwsh"] })).toEqual({ kind: "conditional", platforms: ["darwin"], architectures: ["x64"], shells: ["powershell"] });
 expect(scopeKey({ kind: "conditional", platforms: ["linux", "Windows"] })).toBe(scopeKey({ kind: "conditional", platforms: ["win32", "linux"] }));
 for (const value of [null, { kind: "conditional" }, { kind: "conditional", platforms: [] }, { kind: "project", condition: "Windows" }]) expect(() => normalizeScope(value)).toThrow();
});
it("infers only explicit leading qualifiers and keeps correlated alternatives as text", () => {
 expect(inferScope("Project-wide: Keep storage offline.")).toEqual({ kind: "project" });
 expect(inferScope("Windows only: Use polling.")).toEqual(normalizeScope(windows));
 expect(inferScope("In PowerShell: Use this syntax.")).toEqual({ kind: "conditional", shells: ["powershell"] });
 expect(inferScope("Windows with PowerShell OR Linux with Bash: run this.")).toMatchObject({ kind: "conditional", condition: expect.any(String) });
 expect(inferScope("We discussed Windows during the meeting.")).toEqual({ kind: "unspecified" });
});
it("distinguishes explicit targets, provisional hosts and unchecked conditions", () => {
 expect(assessApplicability({ kind: "project" }).status).toBe("project_wide");
 expect(assessApplicability(undefined, { platform: "Windows" }).status).toBe("needs_verification");
 expect(assessApplicability(windows, { platform: "win32" }).status).toBe("matches");
 const scoped: MemoryScope = { kind: "conditional", platforms: ["win32"], architectures: ["x64"], shells: ["powershell"] };
 expect(assessApplicability(scoped, { platform: "linux" }).status).toBe("mismatch");
 expect(assessApplicability(scoped, { platform: "win32" }).status).toBe("needs_verification");
 expect(assessApplicability({ kind: "conditional", platforms: [process.platform] }).status).toBe("needs_verification");
 expect(assessApplicability(scoped, { shell: "pwsh" }).environment).toEqual({ shell: "powershell" });
 expect(assessApplicability({ ...windows, kind: "conditional", condition: "Node 24 only" }, { platform: "win32" }).status).toBe("needs_verification");
 expect(scopesDisjoint(windows, linux)).toBe(true);
 expect(scopesDisjoint(windows, { kind: "unspecified" })).toBe(false);
});
it("keeps identical memory text distinct by scope and preserves first origin", () => {
 const s = store(); const a = s.upsertMemoryCandidate(mem(windows)); const b = s.upsertMemoryCandidate(mem(linux));
 expect(a.id).not.toBe(b.id); expect(s.upsertMemoryCandidate(mem(windows)).id).toBe(a.id);
 const ma = s.promoteMemoryCandidate(a.id), mb = s.promoteMemoryCandidate(b.id);
 expect(ma.id).not.toBe(mb.id); expect(s.promoteMemoryCandidate(a.id).id).toBe(ma.id);
 expect(s.readMemory(ma.id)!.origin).toBeNull();
 const base = { id: "working", kind: "task_state" as const, title: "Watcher", summary: "Use polling" };
 const t = s.upsertTemporaryMemory({ ...base, scope: windows }); const u = s.upsertTemporaryMemory({ ...base, scope: linux });
 expect(t.id).not.toBe(u.id); expect(s.upsertTemporaryMemory({ ...base, scope: windows }).id).toBe(t.id);
});
it("corrects linked scopes atomically and rejects collisions without changing origin", () => {
 const s = store(); const a = s.upsertMemoryCandidate(mem(windows)); const b = s.upsertMemoryCandidate(mem(linux));
 const m = s.promoteMemoryCandidate(a.id); s.promoteMemoryCandidate(b.id);
 expect(() => updateMemoryScope(s, { memoryId: m.id, category: "promoted", scope: linux, reason: "Correction" })).toThrow(/collides/);
 expect(s.readMemory(m.id)!.scope).toEqual(normalizeScope(windows));
 updateMemoryScope(s, { memoryId: a.id, category: "candidate", scope: { kind: "project" }, reason: "Confirmed on all platforms" });
 expect(s.readMemory(m.id)!.scope).toEqual({ kind: "project" });
 expect(s.listMemoryCandidates({}).find(x => x.id === a.id)!.scope).toEqual({ kind: "project" });
 expect(s.readMemory(m.id)!.origin).toBeNull();
 expect(s.listOperations({ operationType: "scope_change" })).toHaveLength(1);
 expect(JSON.stringify(s.listOperations({ operationType: "scope_change" }))).not.toContain("Confirmed on all platforms");
});
it("keeps mismatches visible in MCP search, decisions and investigations", async () => {
 vi.stubEnv("CODE_BUTLER_HOME", root()); const s = store(); const h = createProjectMemoryToolHandlers(s);
 const saved = h.remember_project_memory({ type: "decision", text: "Use polling for filesystem watcher stability.", scope: windows });
 const result = await h.find_memories({ query: "polling", targetEnvironment: { platform: "linux" } });
 expect(result.results.find(x => x.id === saved.memory.id)!.applicability!.status).toBe("mismatch");
 expect((await h.search_project_memory({ query: "polling", targetEnvironment: { platform: "linux" } })).memories[0]!.applicability!.status).toBe("mismatch");
 const investigation = await h.investigate_project_history({ question: "polling", targetEnvironment: { platform: "linux" } });
 expect(investigation.relatedMemories![0]!.applicability!.status).toBe("mismatch");
 expect(investigation.answer).toContain("Conditional:");
});
it("preserves scope through transfer and imports old records as unspecified", () => {
 const s = store(); const a = s.upsertMemoryCandidate(mem(windows)); s.promoteMemoryCandidate(a.id);
 s.upsertTemporaryMemory({ id: "task", kind: "task_state", title: "Watcher", summary: "polling", scope: linux });
 const file = join(root(), "export.json"); exportPrivacy(s, { outputPath: file });
 const target = store(); importPrivacy(target, { inputPath: file });
 expect(target.listMemories()[0]!.scope).toEqual(normalizeScope(windows));
 const doc = JSON.parse(readFileSync(file, "utf8"));
 for (const table of ["memories", "memory_candidates", "temporary_memories"]) for (const row of doc.tables[table]) { delete row.scope_json; delete row.scope_key; delete row.base_id; }
 writeFileSync(file, JSON.stringify(doc)); const legacy = store(); importPrivacy(legacy, { inputPath: file });
 expect(legacy.listMemories()[0]!.scope).toEqual({ kind: "unspecified" });
});
it("upgrades schema 11 without changing IDs or foreign-key relations", () => {
 const s = openMemoryStore(root()); stores.push(s);
 initializeSchema(s.db, s.paths.databasePath, { migrations: SCHEMA_MIGRATIONS.slice(0, 11) });
 s.db.exec(`insert into temporary_memories (id,project_id,kind,title,summary,details,related_files_json,evidence_json,confidence,created_at,updated_at,expires_at) values ('legacy','project','task_state','old','old','old','[]','[]',1,'2026-01-01','2026-01-01','2030-01-01')`);
 s.db.exec(`insert into temporary_memory_links (id,memory_id,target_type,target_id,metadata_json) values ('link','legacy','file','src/a.ts','{}')`);
 s.init(); expect(s.db.prepare("pragma foreign_key_check").all()).toEqual([]);
 expect(s.db.prepare("select id,scope_key,base_id from temporary_memories").get()).toEqual({ id: "legacy", scope_key: "unspecified", base_id: "legacy" });
 expect(s.db.prepare("select count(*) as n from temporary_memory_links").get()).toEqual({ n: 1 });
});
it("accepts scope through CLI and explicitly corrects it", async () => {
 vi.stubEnv("CODE_BUTLER_HOME", root()); const cwd = root(), lines: string[] = [];
 const options = { cwd, stdout: (line: string) => lines.push(line) };
 expect(await runCli(["memory", "remember", "--type", "decision", "--text", "Use polling for watcher reliability.", "--scope-json", JSON.stringify(windows), "--json"], options)).toBe(0);
 const saved = JSON.parse(lines.join("\n")); lines.length = 0;
 expect(await runCli(["memory", "scope", "--id", saved.memory.id, "--category", "promoted", "--scope-json", '{"kind":"project"}', "--reason", "Verified", "--json"], options)).toBe(0);
 expect(JSON.parse(lines.join("\n")).scope).toEqual({ kind: "project" });
});

it("both extractors accept supported scope, default missing scope, and reject malformed records", async () => {
 const { createAnthropicAwsExtractor } = await import("../src/extract/anthropic-aws.js");
 vi.stubEnv("SCOPE_AWS_KEY", "fixture"); vi.stubEnv("SCOPE_AWS_WORKSPACE", "fixture"); vi.stubEnv("SCOPE_AWS_REGION", "us-east-1");
 const evidence = [{ sourceType: "conversation", sourceId: "session", locator: "session:chunk:0" }];
 const record = { ...mem(), evidence };
 const payload = JSON.stringify({ memories: [{ ...record, scope: windows }, { ...record, dedupeKey: "unknown" }, { ...record, dedupeKey: "invalid", scope: { kind: "conditional" } }] });
 const http = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: payload } }], content: [{ type: "text", text: payload }] }), text: async () => "" });
 const config = { model: "fixture", apiKeyEnv: "SCOPE_AWS_KEY", workspaceIdEnv: "SCOPE_AWS_WORKSPACE", regionEnv: "SCOPE_AWS_REGION" };
 const context = { conversations: [{ sourceId: "session", title: "Watcher", rawContent: "Windows only: Use polling.", chunks: [{ chunkIndex: 0, text: "Windows only: Use polling." }] }], commits: [] };
 for (const extractor of [createOpenAICompatibleExtractor({ ...config, provider: "openai-compatible" }, http as typeof fetch), createAnthropicAwsExtractor({ ...config, provider: "anthropic-aws" }, http)]) {
  const result = await extractor.extract(context);
  expect(result.memories.map(m => m.scope)).toEqual([normalizeScope(windows), { kind: "unspecified" }]);
  expect(result.rejected).toHaveLength(1);
 }
 expect(http).toHaveBeenCalledTimes(2);
});

it("scope redaction recomputes canonical identity during scrub", () => {
 const s = store();
 const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
 const original: MemoryScope = { kind: "conditional", condition: `API_KEY=${secret}` };
 const a = s.upsertMemoryCandidate(mem(windows));
 // Emulate older plaintext written before a privacy policy was enabled.
 s.db.prepare("update memory_candidates set scope_json = ?, scope_key = ? where id = ?").run(JSON.stringify(original), scopeKey(original), a.id);
 scrubPrivacy(s);
 const read = s.listMemoryCandidates({ qualityStatus: "all" })[0]!;
 expect(JSON.stringify(read.scope)).not.toContain(secret);
 expect(s.db.prepare("select scope_key from memory_candidates where id = ?").get(a.id)).toEqual({ scope_key: scopeKey(read.scope) });
});

it("native investigators receive applicability for the explicit execution target", async () => {
 const { investigateProjectHistory } = await import("../src/investigate/history.js");
 const { loadProjectConfig } = await import("../src/config.js");
 vi.stubEnv("CODE_BUTLER_HOME", root()); const s = store();
 rememberProjectMemory(s, { type: "decision", text: "Use polling for filesystem watcher stability.", scope: windows });
 const config = loadProjectConfig(s.paths.rootDir); config.investigator.enabled = true;
 let inspected = false;
 await investigateProjectHistory(s, { question: "polling", targetEnvironment: { platform: "linux", shell: "bash" } }, { config, investigatorProvider: {
  async planNextAction() { return { action: { type: "finalize_answer" }, rationale: "Enough evidence" }; },
  async synthesizeAnswer(state) {
   const memory = state.relatedMemories[0]!;
   expect(memory.scope).toEqual(normalizeScope(windows));
   expect(memory.applicability!.status).toBe("mismatch");
   expect(memory.applicability!.environment).toEqual({ platform: "linux", shell: "bash" });
   inspected = true;
   return { answer: "Windows-only watcher guidance; verify another approach on Linux.", evidenceScore: 1 };
  }
 } });
 expect(inspected).toBe(true);
});
