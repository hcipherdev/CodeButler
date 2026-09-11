import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryOrigin, installationDeviceId, type OriginFactory } from "../src/memory/origin.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { runCli } from "../src/cli.js";
import { addDecision } from "../src/decisions/store.js";
import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import { exportPrivacy, importPrivacy } from "../src/privacy/service.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import { CURRENT_SCHEMA_VERSION, initializeSchema, SCHEMA_MIGRATIONS } from "../src/storage/migrations.js";
import type { ExtractedMemory, MemoryOrigin } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
const stores: MemoryStore[] = [];
const root = () => { const p = makeTempDir(); roots.push(p); return p; };
const store = () => { const s = openMemoryStore(root()); s.init(); stores.push(s); return s; };
const origin = (platform = "darwin"): MemoryOrigin => ({ deviceId: "installation-a", platform, arch: "arm64", generatedAt: "2026-09-06T10:00:00.000Z", method: "deterministic", channel: "sync" });
const memory = (o: MemoryOrigin | null = origin()): ExtractedMemory => ({ origin: o, type: "decision", title: "Keep SQLite", summary: "Use SQLite for offline project memory.", reason: "Core features must work offline.", confidence: 1, evidence: [], relatedFiles: [], dedupeKey: "sqlite" });
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) cleanupTempDir(r); });

it("creates installation identity lazily, respects the global directory, and distinguishes installations", () => {
  const home = root(); vi.stubEnv("CODE_BUTLER_HOME", home);
  const s = store(); s.listMemories({});
  expect(existsSync(join(home, "device.json"))).toBe(false);
  const first = createMemoryOrigin({ method: "manual", channel: "cli" });
  expect(first.deviceId).toBe(installationDeviceId(home));
  expect(first.platform).toBe(process.platform);
  expect(installationDeviceId(root())).not.toBe(first.deviceId);
  expect(Object.keys(JSON.parse(readFileSync(join(home, "device.json"), "utf8")))).toEqual(["deviceId"]);
});

it("publishes one complete identity under concurrent processes", async () => {
  const home = root();
  const script = `import { installationDeviceId } from ${JSON.stringify(resolve("src/memory/origin.ts"))}; console.log(installationDeviceId(process.argv[1]));`;
  const outputs = await Promise.all(Array.from({ length: 5 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home])));
  expect(new Set(outputs.map(x => x.stdout.trim())).size).toBe(1);
  expect(outputs[0]!.stdout.trim()).toBe(installationDeviceId(home));
});

it("preserves first origin across duplicate updates, promotion, lifecycle changes and search", () => {
  const s = store(); const first = s.upsertMemoryCandidate(memory());
  const promoted = s.promoteMemoryCandidate(first.id);
  expect(s.searchMemoryLayer({ query: "SQLite" })[0]!.origin).toEqual(origin());
  expect(s.readMemorySearchResultsByIds([promoted.id])[0]!.origin).toEqual(origin());
  expect(s.searchMemoryLayer({ query: "installation-a" })).toEqual([]);
  s.upsertMemoryCandidate(memory(origin("win32")));
  expect(s.promoteMemoryCandidate(first.id).origin).toEqual(origin());
  expect(s.listMemoryCandidates({})[0]!.origin).toEqual(origin());
  s.updateMemoryLifecycle(promoted.id, { lifecycleStatus: "retracted", statusReason: "Historical" });
  expect(s.readMemory(promoted.id)!.origin).toEqual(origin());
  const unknown = s.upsertMemoryCandidate({ ...memory(null), dedupeKey: "legacy" });
  s.upsertMemoryCandidate({ ...memory(), dedupeKey: "legacy" });
  expect(s.promoteMemoryCandidate(unknown.id).origin).toBeNull();
});

it("preserves temporary origin through updates and exposes it in both retrieval paths", () => {
  const s = store();
  const input = { id: "temp", kind: "task_state" as const, title: "SQLite", summary: "Review SQLite", origin: origin() };
  s.upsertTemporaryMemory(input);
  s.upsertTemporaryMemory({ ...input, origin: origin("win32") });
  expect(s.listActiveTemporaryMemory()[0]!.origin).toEqual(origin());
  expect(s.searchTemporaryMemory({ query: "SQLite" })[0]!.origin).toEqual(origin());
});

it("captures manual and decision paths and MCP client provenance without model-supplied fields", () => {
  const s = store(); const home = root(); vi.stubEnv("CODE_BUTLER_HOME", home);
  const factory: OriginFactory = context => ({ ...origin("win32"), ...context });
  const saved = rememberProjectMemory(s, { type: "decision", text: "Use SQLite because the application must work offline." }, { originFactory: factory });
  expect(saved.memory!.origin).toMatchObject({ method: "manual", channel: "cli", platform: "win32" });
  const decision = addDecision(s, { topic: "Storage", decision: "Use SQLite", reason: "Offline", status: "accepted", evidence: [] }, factory);
  expect(s.readMemory(`memory-manual-${decision.id}`)!.origin).toMatchObject({ method: "manual", channel: "cli" });
  const handlers = createProjectMemoryToolHandlers(s, { clientInfo: () => ({ name: "claude-code", version: "test" }) });
  const mcp = handlers.remember_project_memory({ type: "constraint", text: "Keep all core operations available without an API key." });
  expect(mcp.memory!.origin).toMatchObject({ channel: "mcp", client: { name: "claude-code", version: "test" } });
});

it("round-trips origins and accepts legacy exports without stamping the receiving device", () => {
  const source = store(); const c = source.upsertMemoryCandidate(memory()); source.promoteMemoryCandidate(c.id);
  source.upsertTemporaryMemory({ title: "Next", summary: "Review storage", kind: "task_state", origin: origin() });
  const output = join(root(), "export.json"); exportPrivacy(source, { outputPath: output });
  const target = store(); importPrivacy(target, { inputPath: output });
  expect(target.listMemories({})[0]!.origin).toEqual(origin());
  expect(target.listMemoryCandidates({})[0]!.origin).toEqual(origin());
  expect(target.db.prepare("select origin_json from temporary_memories").get()).toMatchObject({ origin_json: JSON.stringify(origin()) });
  const legacy = JSON.parse(readFileSync(output, "utf8"));
  for (const table of ["memories", "memory_candidates", "temporary_memories"]) for (const row of legacy.tables[table]) delete row.origin_json;
  writeFileSync(output, JSON.stringify(legacy));
  const older = store(); importPrivacy(older, { inputPath: output });
  expect(older.listMemories({})[0]!.origin).toBeNull();
});

it("validates imported origin and redacts optional client fields at storage", () => {
  const s = store(); const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const c = s.upsertMemoryCandidate(memory({ ...origin(), client: { name: `OPENAI_API_KEY=${secret}` } }));
  expect(JSON.stringify(c.origin)).not.toContain(secret);
  const output = join(root(), "invalid.json"); exportPrivacy(s, { outputPath: output });
  const doc = JSON.parse(readFileSync(output, "utf8")); doc.tables.memory_candidates[0].origin_json = '{"method":"invented"}'; writeFileSync(output, JSON.stringify(doc));
  expect(() => importPrivacy(store(), { inputPath: output })).toThrow("Invalid memory origin");
});

it("migration 11 preserves legacy unknown origins", () => {
  const s = openMemoryStore(root()); stores.push(s);
  initializeSchema(s.db, s.paths.databasePath, { migrations: SCHEMA_MIGRATIONS.slice(0, 10) });
  s.db.exec(`insert into memory_candidates
    (id,type,title,summary,reason,confidence,evidence_json,related_files_json,dedupe_key,promotion_state,evidence_signature,created_at,updated_at)
    values ('legacy','decision','Old','Old','Old',1,'[]','[]','legacy','candidate','','2026-01-01','2026-01-01')`);
  s.init();
  expect(CURRENT_SCHEMA_VERSION).toBe(18);
  expect(s.listMemoryCandidates({}).find(x => x.id === "legacy")!.origin).toBeNull();
});

it("returns origin in CLI JSON and a readable origin line", async () => {
  const home = root(); vi.stubEnv("CODE_BUTLER_HOME", home);
  const cwd = root(); const lines: string[] = [];
  const args = ["memory", "remember", "--type", "decision", "--text", "Use SQLite for offline project memory."];
  expect(await runCli([...args, "--json"], { cwd, stdout: line => lines.push(line) })).toBe(0);
  const saved = JSON.parse(lines.join("\n"));
  expect(saved.memory.origin).toMatchObject({ method: "manual", channel: "cli" });
  lines.length = 0;
  expect(await runCli(args, { cwd, stdout: line => lines.push(line) })).toBe(0);
  expect(lines.join("\n")).toContain(`Origin: ${process.platform}/${process.arch}`);
});
