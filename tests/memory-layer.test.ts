import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CORE_LAYER, deviceLayer, formatLayer, isCoreLayer, layerLabel, memoryLayerInputSchema,
  matchesLayerFilter, normalizeLayer, parseLayer
} from "../src/memory/layer.js";
import { defaultBranchMemoryLayer, readMemoryBranchContext } from "../src/memory/branch.js";
import { updateMemoryLayer } from "../src/memory/layer-service.js";
import { suggestMemoryLayerPromotions } from "../src/memory/layer-promotion.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { createProjectMemoryToolHandlers } from "../src/mcp/tools.js";
import { exportPrivacy, importPrivacy } from "../src/privacy/service.js";
import { initializeSchema, SCHEMA_MIGRATIONS } from "../src/storage/migrations.js";
import { openMemoryStore, type MemoryStore } from "../src/storage/store.js";
import { runCli } from "../src/cli.js";
import type { ExtractedMemory } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [], stores: MemoryStore[] = [];
const DEVICE = "9f2c4d1e-3b7a-4c5d-8e6f-0a1b2c3d4e5f";
function root() { const r = makeTempDir(); roots.push(r); return r; }
function store() {
  const s = openMemoryStore(root(), { deviceLayer: () => `device:${DEVICE}` });
  s.init(); stores.push(s); return s;
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function initRepoOnFeatureBranch(branch = "feature/layered-memory"): string {
  const repo = root();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["checkout", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "Initial commit"]);
  git(repo, ["checkout", "-b", branch]);
  return repo;
}
const mem = (layer?: string, dedupeKey = "watcher"): ExtractedMemory => ({
  ...(layer ? { layer } : {}), type: "decision", title: "Watcher",
  summary: "Use polling for file watching.", reason: "Native notifications fail.",
  confidence: 1, dedupeKey, evidence: [], relatedFiles: []
});
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.unstubAllEnvs(); roots.splice(0).forEach(cleanupTempDir); });

it("parses the canonical grammar and rejects malformed layers", () => {
  expect(parseLayer(undefined)).toEqual({ kind: "core" });
  expect(parseLayer("core")).toEqual({ kind: "core" });
  expect(parseLayer(`device:${DEVICE}`)).toEqual({ kind: "device", deviceId: DEVICE });
  expect(parseLayer("branch:feature-auth")).toEqual({ kind: "branch", branch: "feature-auth" });
  expect(parseLayer(`branch:feature-auth:device:${DEVICE}`)).toEqual({ kind: "branch", branch: "feature-auth", deviceId: DEVICE });
  // Round-trips, so migration 13 never has to be revisited for the deferred branch phase.
  for (const value of ["core", `device:${DEVICE}`, "branch:release/v2", `branch:release/v2:device:${DEVICE}`]) {
    expect(formatLayer(parseLayer(value))).toBe(value);
    expect(normalizeLayer(value)).toBe(value);
  }
  expect(normalizeLayer(`DEVICE:${DEVICE.toUpperCase()}`)).toBe(`device:${DEVICE}`);
  for (const bad of ["device:not-a-uuid", "device:", "branch:", "branch:has space", "elsewhere", "branch:..", "branch:-x", 7]) {
    expect(() => normalizeLayer(bad)).toThrow();
  }
  expect(memoryLayerInputSchema.safeParse("device")).toMatchObject({ success: true });
});

it("classifies layers for predicates, filters and labels", () => {
  expect(isCoreLayer(undefined)).toBe(true);
  expect(isCoreLayer(`device:${DEVICE}`)).toBe(false);
  expect(deviceLayer(DEVICE.toUpperCase())).toBe(`device:${DEVICE}`);
  expect(matchesLayerFilter(`device:${DEVICE}`, "all")).toBe(true);
  expect(matchesLayerFilter(`device:${DEVICE}`, undefined)).toBe(true);
  expect(matchesLayerFilter(`device:${DEVICE}`, "device")).toBe(true);
  expect(matchesLayerFilter(`device:${DEVICE}`, "core")).toBe(false);
  expect(matchesLayerFilter("branch:x", "branch")).toBe(true);
  expect(layerLabel("core")).toMatch(/shared/i);
  expect(layerLabel(`device:${DEVICE}`)).toContain(DEVICE);
});

it("detects branch/device layers only off the default git branch", () => {
  const repo = initRepoOnFeatureBranch("feature/branch-memory");

  expect(readMemoryBranchContext(repo)).toMatchObject({
    branch: "feature/branch-memory",
    isDefaultBranch: false,
    isDetached: false
  });
  expect(defaultBranchMemoryLayer(repo, { deviceId: DEVICE }))
    .toBe(`branch:feature/branch-memory:device:${DEVICE}`);

  git(repo, ["checkout", "main"]);
  expect(readMemoryBranchContext(repo)).toMatchObject({ branch: "main", isDefaultBranch: true });
  expect(defaultBranchMemoryLayer(repo, { deviceId: DEVICE })).toBeUndefined();
  expect(defaultBranchMemoryLayer(join(repo, "missing"), { deviceId: DEVICE })).toBeUndefined();
});

it("defaults durable memories to core and working context to this device", () => {
  const s = store();
  const candidate = s.upsertMemoryCandidate(mem());
  expect(candidate.layer).toBe(CORE_LAYER);
  expect(s.promoteMemoryCandidate(candidate.id, "manual").layer).toBe(CORE_LAYER);
  const temporary = s.upsertTemporaryMemory({ title: "Task", summary: "In progress", kind: "task_state" });
  expect(temporary.layer).toBe(`device:${DEVICE}`);
  // A stable caller id survives the device default.
  expect(s.upsertTemporaryMemory({ id: "stable", title: "T", summary: "S", kind: "task_state" }).id).toBe("stable");
});

it("defaults unpromoted explicit memories to the branch/device layer when provided", () => {
  const s = store();
  const branchLayer = `branch:feature/branch-memory:device:${DEVICE}`;

  const candidateOnly = rememberProjectMemory(s, {
    type: "decision",
    text: "Keep the branch cache experiment local until review.",
    promote: false
  }, { defaultLayer: branchLayer });
  expect(candidateOnly.memory).toBeUndefined();
  expect(candidateOnly.candidate.layer).toBe(branchLayer);

  const promoted = rememberProjectMemory(s, {
    type: "decision",
    text: "Adopt deterministic summaries for the shared project."
  }, { defaultLayer: branchLayer });
  expect(promoted.memory!.layer).toBe(CORE_LAYER);

  const explicit = rememberProjectMemory(s, {
    type: "constraint",
    text: "Only this laptop should run the local branch cache probe.",
    layer: `device:${DEVICE}`,
    promote: false
  }, { defaultLayer: branchLayer });
  expect(explicit.candidate.layer).toBe(`device:${DEVICE}`);
});

it("keeps the same fact in two layers as distinct rows", () => {
  const s = store();
  const core = s.upsertMemoryCandidate(mem());
  const local = s.upsertMemoryCandidate(mem(`device:${DEVICE}`));
  expect(local.id).not.toBe(core.id);
  expect(s.promoteMemoryCandidate(core.id, "manual").id).not.toBe(s.promoteMemoryCandidate(local.id, "manual").id);
  expect(s.db.prepare("select count(*) as n from memories").get()).toEqual({ n: 2 });
  expect(s.db.prepare("select count(*) as n from memory_candidates").get()).toEqual({ n: 2 });
  expect(s.db.prepare("pragma foreign_key_check").all()).toEqual([]);
});

it("remembers an explicit layer and keeps its source row separate", () => {
  const s = store();
  const core = rememberProjectMemory(s, { type: "decision", text: "Ship the watcher behind a flag." });
  const local = rememberProjectMemory(s, { type: "decision", text: "Ship the watcher behind a flag.", layer: `device:${DEVICE}` });
  expect(core.memory?.layer).toBe(CORE_LAYER);
  expect(local.memory?.layer).toBe(`device:${DEVICE}`);
  expect(core.sourceId).not.toBe(local.sourceId);
  expect(local.sourceId).toContain(`:layer:device:${DEVICE}`);
});

it("filters find_memories by layer while defaulting to every layer", async () => {
  const s = store();
  rememberProjectMemory(s, { type: "decision", text: "Keep storage offline by default." });
  rememberProjectMemory(s, { type: "constraint", text: "This laptop needs the legacy toolchain." , layer: `device:${DEVICE}` });
  const handlers = createProjectMemoryToolHandlers(s, { rootDir: s.paths.rootDir });
  const layersOf = async (layer?: "core" | "device" | "branch" | "all") =>
    (await handlers.find_memories({ ...(layer ? { layer } : {}), status: "promoted", qualityStatus: "all", lifecycleStatus: "all", limit: 50 }))
      .results.map(r => r.layer).sort();
  expect(await layersOf()).toEqual([CORE_LAYER, `device:${DEVICE}`]);
  expect(await layersOf("all")).toEqual([CORE_LAYER, `device:${DEVICE}`]);
  expect(await layersOf("core")).toEqual([CORE_LAYER]);
  expect(await layersOf("device")).toEqual([`device:${DEVICE}`]);
  expect(await layersOf("branch")).toEqual([]);
});

it("filters by layer in storage so the limit cannot hide older non-core memories", async () => {
  const s = store();
  // Oldest write, so every core memory below outranks it in promoted_at order.
  rememberProjectMemory(s, { type: "constraint", text: "This laptop needs the legacy toolchain.", layer: `device:${DEVICE}` });
  for (let index = 0; index < 101; index += 1) {
    rememberProjectMemory(s, { type: "decision", text: `Core decision number ${index}.` });
  }
  const handlers = createProjectMemoryToolHandlers(s, { rootDir: s.paths.rootDir });

  // Filtering after a bounded query returned nothing here: the 100-row page was
  // entirely core, so the single older device memory never reached the filter.
  const device = await handlers.find_memories({
    layer: "device", status: "promoted", qualityStatus: "all", lifecycleStatus: "all", limit: 100
  });
  expect(device.results.map(result => result.layer)).toEqual([`device:${DEVICE}`]);

  // The limit now bounds matching rows, so a core query still fills the page.
  const core = await handlers.find_memories({
    layer: "core", status: "promoted", qualityStatus: "all", lifecycleStatus: "all", limit: 100
  });
  expect(core.results).toHaveLength(100);
  expect(core.results.every(result => result.layer === CORE_LAYER)).toBe(true);
});

it("moves linked durable memories between layers and logs a privacy-safe operation", () => {
  const s = store();
  const remembered = rememberProjectMemory(s, { type: "decision", text: "Keep the watcher polling.", layer: `device:${DEVICE}` });
  const result = updateMemoryLayer(s, {
    memoryId: remembered.memory!.id,
    category: "promoted",
    layer: CORE_LAYER,
    reason: "Confirmed as a shared project convention."
  }, "cli");
  expect(result).toMatchObject({ memoryId: remembered.memory!.id, category: "promoted", layer: CORE_LAYER });
  expect(result.updatedMemoryIds.sort()).toEqual([remembered.candidate.id, remembered.memory!.id].sort());
  expect(s.readMemory(remembered.memory!.id)!.layer).toBe(CORE_LAYER);
  expect(s.listMemoryCandidates({ qualityStatus: "all" }).find(x => x.id === remembered.candidate.id)!.layer).toBe(CORE_LAYER);
  expect(s.readMemory(remembered.memory!.id)!.origin).toEqual(remembered.memory!.origin);
  expect(s.listOperations({ operationType: "layer_change" })).toHaveLength(1);
  expect(JSON.stringify(s.listOperations({ operationType: "layer_change" }))).not.toContain("Confirmed as a shared project convention");
});

it("moves temporary memories independently and rejects layer collisions atomically", () => {
  const s = store();
  const temporary = s.upsertTemporaryMemory({ id: "stable", title: "Task", summary: "In progress", kind: "task_state" });
  updateMemoryLayer(s, { memoryId: temporary.id, category: "temporary", layer: "branch:feature-auth", reason: "Tied to branch work." });
  expect(s.db.prepare("select layer from temporary_memories where id = ?").get(temporary.id)).toEqual({ layer: "branch:feature-auth" });

  const core = s.upsertMemoryCandidate(mem());
  const local = s.upsertMemoryCandidate(mem(`device:${DEVICE}`));
  s.promoteMemoryCandidate(core.id);
  const localMemory = s.promoteMemoryCandidate(local.id);
  expect(() => updateMemoryLayer(s, { memoryId: localMemory.id, category: "promoted", layer: CORE_LAYER, reason: "Try to share it." })).toThrow(/collides/);
  expect(s.readMemory(localMemory.id)!.layer).toBe(`device:${DEVICE}`);
  expect(s.listMemoryCandidates({ qualityStatus: "all" }).find(x => x.id === local.id)!.layer).toBe(`device:${DEVICE}`);
});

it("suggests high-signal non-core durable memories for reviewed promotion to core", () => {
  const s = store();
  const shared = rememberProjectMemory(s, {
    type: "constraint",
    text: "Keep generated project summaries deterministic.",
    scope: { kind: "project" },
    layer: `device:${DEVICE}`
  });
  const local = rememberProjectMemory(s, {
    type: "constraint",
    text: "This laptop keeps the staging token in Keychain.",
    layer: `device:${DEVICE}`
  });
  const branchCandidate = s.upsertMemoryCandidate({
    ...mem("branch:feature-layered-memory", "branch-review"),
    scope: { kind: "project" }
  });

  const result = suggestMemoryLayerPromotions(s, { limit: 10 });

  expect(result).toMatchObject({ scanned: 3, eligible: 3, complete: true });
  expect(result.suggestions.map((suggestion) => suggestion.memoryId)).toContain(shared.memory!.id);
  expect(result.suggestions.map((suggestion) => suggestion.memoryId)).toContain(branchCandidate.id);
  expect(result.suggestions.map((suggestion) => suggestion.memoryId)).not.toContain(local.memory!.id);
  expect(result.suggestions.find((suggestion) => suggestion.memoryId === shared.memory!.id)).toMatchObject({
    category: "promoted",
    targetLayer: CORE_LAYER,
    reasons: expect.arrayContaining(["active_quality", "high_confidence", "project_scope"]),
    action: { tool: "update_memory_layer", arguments: { memoryId: shared.memory!.id, category: "promoted", layer: CORE_LAYER } }
  });
  expect(result.suggestions.find((suggestion) => suggestion.memoryId === branchCandidate.id)!.warnings)
    .toContain("branch_candidate_requires_triage_resolution");
  expect(result.suggestions.find((suggestion) => suggestion.memoryId === branchCandidate.id)!.action)
    .toMatchObject({
      tool: "resolve_branch_memory_triage",
      arguments: { memoryId: branchCandidate.id, category: "candidate", action: "promote_to_core" }
    });
  expect(suggestMemoryLayerPromotions(s, { layer: "device", limit: 10 }).suggestions.map((suggestion) => suggestion.memoryId))
    .toEqual([shared.memory!.id]);
});

it("backfills existing rows to core when upgrading schema 12", () => {
  const s = openMemoryStore(root()); stores.push(s);
  initializeSchema(s.db, s.paths.databasePath, { migrations: SCHEMA_MIGRATIONS.slice(0, 12) });
  s.db.exec(`insert into temporary_memories (base_id,id,project_id,kind,title,summary,details,related_files_json,evidence_json,confidence,created_at,updated_at,expires_at) values ('legacy','legacy','project','task_state','old','old','old','[]','[]',1,'2026-01-01','2026-01-01','2030-01-01')`);
  s.db.exec(`insert into memories (id,type,title,summary,reason,confidence,evidence_json,related_files_json,dedupe_key,evidence_signature,source,quality_status,quality_reasons_json,subject_key,lifecycle_status,valid_from,status_changed_at,created_at,promoted_at) values ('legacy-memory','decision','t','s','r',1,'[]','[]','dk','sig','manual','active','[]','decision:t','current','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`);
  const before = s.db.prepare("select count(*) as n from temporary_memories").get();
  s.init();
  expect(s.db.prepare("pragma foreign_key_check").all()).toEqual([]);
  expect(s.db.prepare("select count(*) as n from temporary_memories").get()).toEqual(before);
  expect(s.db.prepare("select id,layer from memories").all()).toEqual([{ id: "legacy-memory", layer: "core" }]);
  expect(s.db.prepare("select id,layer from temporary_memories").all()).toEqual([{ id: "legacy", layer: "core" }]);
});

it("round-trips the layer through privacy export and import", () => {
  const s = store();
  rememberProjectMemory(s, { type: "decision", text: "Keep the watcher polling." });
  rememberProjectMemory(s, { type: "constraint", text: "Only this laptop has the signing key.", layer: `device:${DEVICE}` });
  const outputPath = join(root(), "export.json");
  exportPrivacy(s, { outputPath });
  const target = store();
  importPrivacy(target, { inputPath: outputPath });
  expect(target.db.prepare("select layer from memories order by layer").all())
    .toEqual([{ layer: "core" }, { layer: `device:${DEVICE}` }]);
});

it("accepts a layer through the CLI", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", root());
  const cwd = root(), lines: string[] = [];
  const options = { cwd, stdout: (line: string) => lines.push(line) };
  expect(await runCli(["memory", "remember", "--type", "decision", "--text", "Pin the toolchain locally.", "--layer", `device:${DEVICE}`, "--json"], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).memory.layer).toBe(`device:${DEVICE}`);
  lines.length = 0;
  expect(await runCli(["memory", "remember", "--type", "decision", "--text", "Adopt the shared convention.", "--json"], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).memory.layer).toBe(CORE_LAYER);
  const saved = JSON.parse(lines.join("\n")).memory;
  lines.length = 0;
  expect(await runCli(["memory", "layer", "--id", saved.id, "--category", "promoted", "--layer", "device", "--reason", "Keep local for now.", "--json"], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).layer).toMatch(/^device:[0-9a-f-]{36}$/);
  lines.length = 0;
  expect(await runCli(["memory", "remember", "--type", "constraint", "--text", "Keep docs deterministic.", "--scope-json", '{"kind":"project"}', "--layer", `device:${DEVICE}`, "--json"], options)).toBe(0);
  lines.length = 0;
  expect(await runCli(["memory", "promotions", "--json"], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).suggestions).toEqual([
    expect.objectContaining({ currentLayer: `device:${DEVICE}`, targetLayer: CORE_LAYER })
  ]);
  lines.length = 0;
  const errors: string[] = [];
  expect(await runCli(["memory", "remember", "--type", "decision", "--text", "x", "--layer", "nonsense"], { ...options, stderr: (line: string) => errors.push(line) })).toBe(1);
  expect(errors.join("\n")).toMatch(/layer/i);
});

it("defaults CLI candidate remembers to the current feature branch layer", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", root());
  const cwd = initRepoOnFeatureBranch("feature/cli-memory");
  const lines: string[] = [];
  const options = { cwd, stdout: (line: string) => lines.push(line) };

  expect(await runCli([
    "memory", "remember",
    "--type", "decision",
    "--text", "Keep the CLI branch experiment local until merge review.",
    "--candidate",
    "--json"
  ], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).candidate.layer)
    .toMatch(/^branch:feature\/cli-memory:device:[0-9a-f-]{36}$/);

  lines.length = 0;
  expect(await runCli([
    "memory", "remember",
    "--type", "decision",
    "--text", "Adopt the CLI shared convention after review.",
    "--json"
  ], options)).toBe(0);
  expect(JSON.parse(lines.join("\n")).memory.layer).toBe(CORE_LAYER);
});

it("defaults MCP candidate remembers to the current feature branch layer", () => {
  vi.stubEnv("CODE_BUTLER_HOME", root());
  const cwd = initRepoOnFeatureBranch("feature/mcp-memory");
  const s = openMemoryStore(cwd);
  s.init();
  stores.push(s);

  const handlers = createProjectMemoryToolHandlers(s, { rootDir: cwd });
  const result = handlers.remember_project_memory({
    type: "constraint",
    text: "Keep the MCP branch experiment local until merge review.",
    promote: false
  });

  expect(result.memory.kind).toBe("candidate");
  expect(result.memory.layer).toMatch(/^branch:feature\/mcp-memory:device:[0-9a-f-]{36}$/);
});
