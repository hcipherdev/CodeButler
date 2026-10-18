import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanupTempDir } from "./helpers/temp.js";
import { parseRuleFile, serializeRule } from "../src/rules/format.js";
import { globalRulesRoot, globalRulesProjectId, assertOrdinaryProject } from "../src/rules/identity.js";
import { captureRulesFiles, createRule, listRules, updateRule, deleteRule, resolveRuleConflict, replaceRulesFiles, recoverRulesApply } from "../src/rules/store.js";
import { atomicJson, stateDirectory, saveBinding } from "../src/cloud/state.js";
import { newRuntimeRecord } from "../src/runtime.js";
import { syncGlobalRules, setGlobalRulesSyncEnabled, encryptedRulesSync } from "../src/rules/sync.js";
import type { AccountClient } from "../src/cloud/account-client.js";
import { planMemoryReconciliation } from "../src/memory/reconciliation.js";
import { getApplicableRules, buildRulesCatalog, PAGE_BYTES, globToRegExp } from "../src/rules/match.js";
import { contentHash, decodeRulesFiles, encodeRulesFiles, filesRevision, mergeRules, conflictsIn, stateHash, type RuleFiles } from "../src/rules/merge.js";

const roots: string[] = [];
const temp = () => { const path = makeTempDir(); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
const rule = (id = "debug", body = "Put debug notes in docs/debug/.", extra = {}) => serializeRule({ schemaVersion: 1, id, title: id, body, triggers: { actions: ["create_doc"] }, ...extra });
const files = (value: Record<string, string>): RuleFiles => new Map(Object.entries(value).map(([id, body]) => [`rules/${id}.md`, Buffer.from(rule(id, body))]));
function setup() { const home = temp(), project = temp(); vi.stubEnv("CODE_BUTLER_HOME", home); return { home, project, root: globalRulesRoot() }; }
describe("manual global rules format", () => {
  it("round trips defaults, quotes, lists, and literal comment characters", () => {
    const text = rule("debug", "Keep # Markdown.", { title: "Rules: # keep", applies: { markers: ["package.json"] } });
    const parsed = parseRuleFile(text, "debug.md"); expect(parsed.ok).toBe(true);
    if (parsed.ok) { expect(parsed.rule.title).toBe("Rules: # keep"); expect(serializeRule(parsed.rule)).toBe(text); }
    expect(parseRuleFile(text.replace("schemaVersion: 1", "schemaVersion: 1 # comment"), "debug.md").ok).toBe(true);
  });
  it("takes a missing id from its filename and rejects mismatches, duplicate keys and versions", () => {
    expect(parseRuleFile(rule().replace("id: debug\n", ""), "debug.md").ok).toBe(true);
    expect(parseRuleFile(rule(), "other.md").ok).toBe(false);
    expect(parseRuleFile(rule().replace("schemaVersion: 1", "schemaVersion: 2"), "debug.md").ok).toBe(false);
    expect(parseRuleFile(rule().replace("id: debug", "id: debug\nid: debug"), "debug.md").ok).toBe(false);
  });
  it("counts UTF-8 bytes and rejects secrets and unsafe markers", () => {
    expect(() => rule("debug", "界".repeat(1400))).toThrow("4 KiB");
    expect(() => rule("debug", "API_KEY=real-value")).toThrow("secret");
    expect(() => rule("debug", "hello", { applies: { markers: ["../secret"] } })).toThrow("relative");
  });
});
describe("global rules store and retrieval", () => {
  it("reads an absent store without initializing files", () => { const { root, project } = setup(); expect(listRules().rules).toEqual([]); getApplicableRules(project); expect(existsSync(root)).toBe(false); });
  it("keeps stable ids, rejects stale edits, and observes hand edits and deletion", async () => {
    setup(); const created = await createRule({ title: "Debug notes", body: "Store notes here." });
    const updated = await updateRule(created.id, { title: "Renamed" }, created.contentHash); expect(updated.id).toBe(created.id);
    await expect(updateRule(created.id, { body: "Stale" }, created.contentHash)).rejects.toThrow("changed");
    const path = join(globalRulesRoot(), ".code-butler", "rules", `${created.id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("Store notes here.", "Manual edit."));
    expect(listRules().rules[0]!.body).toBe("Manual edit.");
    await expect(deleteRule(created.id, updated.contentHash)).rejects.toThrow("changed");
    unlinkSync(path); expect(listRules().rules).toHaveLength(0);
    const longTitle = await createRule({ title: `${"a".repeat(59)} long title`, body: "Portable id." });
    expect(longTitle.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
  it("matches fresh action, marker, file, and keyword contexts", async () => {
    const { project } = setup();
    await createRule({ title: "Tests", body: "Run tests.", applies: { markers: ["package.json"] }, triggers: { actions: ["run_tests"] } });
    expect(getApplicableRules(project, { actions: ["run_tests"] }).rules).toHaveLength(0);
    writeFileSync(join(project, "package.json"), "{}");
    expect(getApplicableRules(project, { actions: ["run_tests"] }).rules).toHaveLength(1);
    expect(getApplicableRules(project, { actions: ["create_doc"] }).rules).toHaveLength(0);
    await createRule({ title: "Notes", body: "Put notes in {projectRoot}, {path:secret}, and {path:Missing_Name}.", triggers: { paths: ["**/*debug*.md"], keywords: ["debug"] } });
    expect(globToRegExp("**/*debug*.md").test("debug.md")).toBe(true);
    const match = getApplicableRules(project, { task: "debug issue", targetEnvironment: { location: "local", platform: process.platform } }).rules[0]!;
    expect("unresolved" in match && match.unresolved).toEqual(["{path:secret}", "{path:Missing_Name}"]);
    expect(getApplicableRules(project, { task: "debugger" }).rules).toHaveLength(0);
  });
  it("respects exclusions and uncertain execution conditions", async () => {
    const { project } = setup(); const created = await createRule({ title: "Shell", body: "Use PowerShell.", core: true, applies: { shells: ["powershell"] } });
    const first = getApplicableRules(project).rules[0]!; expect("applicability" in first && first.applicability).toBe("needsVerification");
    expect(first).toMatchObject({ applicabilityInfo: { conditions: { shells: ["powershell"] } } });
    expect(getApplicableRules(project, { targetEnvironment: { shell: "bash" } }).rules).toHaveLength(0);
    mkdirSync(join(project, ".code-butler")); writeFileSync(join(project, ".code-butler", "config.json"), JSON.stringify({ globalRules: { exclude: [created.id] } }));
    expect(getApplicableRules(project, { ids: [created.id] }).notApplicable[0]!.reasons[0]).toContain("Excluded");
  });
  it("paginates required rules within hard budgets and invalidates changed contexts", async () => {
    const { project } = setup();
    for (let i = 0; i < 5; i++) await createRule({ title: `Core ${i}`, severity: "must", core: true, body: "a".repeat(4000) });
    const first = getApplicableRules(project); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(PAGE_BYTES); expect(first.requiredRemaining).toBeGreaterThan(0); expect(first.nextCursor).toBeTruthy();
    const second = getApplicableRules(project, { cursor: first.nextCursor! }); expect(second.restartRequired).toBeUndefined(); expect(second.rules[0]!.id).not.toBe(first.rules[0]!.id);
    expect(getApplicableRules(project, { cursor: first.nextCursor!, task: "changed" }).restartRequired).toBe(true);
    const brief = buildRulesCatalog(project); expect(Buffer.byteLength(JSON.stringify(brief.core))).toBeLessThanOrEqual(3072);
  });
  it("rejects using global rules as a project", () => { const { root } = setup(); expect(() => assertOrdinaryProject(root)).toThrow("manually"); expect(globalRulesProjectId("00000000-0000-4000-8000-000000000000")).toMatch(/-5[0-9a-f]{3}-/); });
  it("requires confirmed target conditions and refreshes local location bindings", async () => {
    const { project, root } = setup();
    await createRule({ title: "Conditional", core: true, body: "Find env at {path:env} in {projectRoot}.", applies: { platforms: [process.platform === "win32" ? "linux" : "win32"] } });
    expect(getApplicableRules(project).rules[0]).toMatchObject({ applicability: "needsVerification", unresolved: ["{path:env}", "{projectRoot}"] });
    expect(getApplicableRules(project, { targetEnvironment: { platform: process.platform } }).rules).toHaveLength(0);
    await createRule({ title: "Locations", body: "Find env at {path:env}.", core: true });
    const path = join(root, ".code-butler/config.local.json"), local = { platform: process.platform, location: "local" as const };
    writeFileSync(path, JSON.stringify({ rulePaths: { env: join(project, "first") } }));
    const a = getApplicableRules(project, { targetEnvironment: local });
    writeFileSync(path, JSON.stringify({ rulePaths: { env: join(project, "second") } }));
    const b = getApplicableRules(project, { targetEnvironment: local });
    expect(b.catalogRevision).not.toBe(a.catalogRevision); expect(b.rules[0]).toMatchObject({ body: `Find env at ${join(project, "second")}.` });
    writeFileSync(path, JSON.stringify({ rulePaths: { env: "relative/path" } }));
    expect(() => getApplicableRules(project)).toThrow("absolute local paths");
  });
  it("serves complete bodies with large metadata and defers oversized placeholder expansion", async () => {
    const { project } = setup();
    const body = "{projectRoot}".repeat(250);
    await createRule({ title: "Paths", core: true, body, triggers: { paths: Array.from({ length: 32 }, (_, i) => `${i}${"a".repeat(238)}`) } });
    const page = getApplicableRules(project, { targetEnvironment: { location: "local", platform: process.platform } });
    expect(page.oversized).toEqual([]); expect(page.rules[0]).toMatchObject({ body, unresolved: ["{projectRoot}"] });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PAGE_BYTES);
  });
  it("fits escaped bodies and unverified shell qualifiers within the page budget", () => {
    const { root, project } = setup(), directory = join(root, ".code-butler/rules"); mkdirSync(directory, { recursive: true });
    const body = "\\".repeat(4096), shells = Array.from({ length: 32 }, (_, i) => `s${String(i).padStart(2, "0")}${"x".repeat(61)}`);
    writeFileSync(join(directory, "bounded.md"), rule("bounded", body, { title: "界".repeat(200), core: true, applies: { shells } }));
    const page = getApplicableRules(project);
    expect(page.oversized).toEqual([]); expect(page.rules[0]).toMatchObject({ body, applicabilityInfo: { conditions: { shells } } });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PAGE_BYTES);
  });
  it("recovers partial application and refuses to overwrite an intervening external edit", async () => {
    const { root } = setup(); await createRule({ title: "Init", body: "Manual rule." });
    const before = files({ a: "old", b: "old" }), after = files({ a: "new", b: "new" });
    replaceRulesFiles(root, filesRevision(captureRulesFiles()), before);
    const packed = (value: RuleFiles) => Object.fromEntries([...value].map(([p, b]) => [p, b.toString("base64")]));
    const journal = join(stateDirectory(root), "rules-apply.json");
    atomicJson(journal, { before: packed(before), after: packed(after) });
    writeFileSync(join(root, ".code-butler/rules/a.md"), after.get("rules/a.md")!);
    recoverRulesApply(root); expect(captureRulesFiles()).toEqual(after); expect(existsSync(journal)).toBe(false);
    atomicJson(journal, { before: packed(after), after: packed(before) });
    writeFileSync(join(root, ".code-butler/rules/a.md"), rule("a", "Intervening edit"));
    expect(() => recoverRulesApply(root)).toThrow("external edit");
    expect(readFileSync(join(root, ".code-butler/rules/a.md"), "utf8")).toContain("Intervening edit"); expect(existsSync(journal)).toBe(true);
  });
  it("queues manual sync through the watcher without registering a project ingestion root", async () => {
    const { root, home } = setup(); await createRule({ title: "Queue", body: "Manual rule." });
    const vaultId = "00000000-0000-4000-8000-000000000000";
    saveBinding(root, { kind: "global-rules", enabled: true, server: "http://unused.test", vaultId, projectId: globalRulesProjectId(vaultId), fingerprint: "", revision: 0, status: "ready" });
    atomicJson(join(home, "watch/runner.json"), newRuntimeRecord("watcher", home));
    const refreshVault = vi.fn();
    const result = await syncGlobalRules({ waitMs: 1, client: { refreshVault } as unknown as AccountClient });
    expect(result).toMatchObject({ queued: true, outcome: "queued" }); expect(refreshVault).not.toHaveBeenCalled();
    await expect(planMemoryReconciliation(root)).rejects.toThrow("manually maintained");
  });
  it("reports the reserved slot quota without rebinding to an unrelated resource", async () => {
    setup();
    // Ten ordinary project ids, which are always UUIDs on a real account.
    const client = { server: "http://unused.test", refreshVault: async () => ({ descriptor: { vaultId: "00000000-0000-4000-8000-000000000000" }, projects: Object.fromEntries(Array.from({length: 10}, (_, i) => [`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, 1])) }) } as unknown as AccountClient;
    await expect(setGlobalRulesSyncEnabled(true, client)).rejects.toThrow("one project slot");
  });
  it("enters recovery instead of inventing an empty base for an established binding", async () => {
    const { root } = setup(); await createRule({ title: "Retained", body: "Keep these exact bytes." });
    const before = captureRulesFiles(), vaultId = "00000000-0000-4000-8000-000000000000";
    saveBinding(root, { kind: "global-rules", enabled: true, server: "http://unused.test", vaultId, projectId: globalRulesProjectId(vaultId), fingerprint: "previously-accepted", revision: 3, status: "ready" });
    const refreshVault = vi.fn(), client = { refreshVault, security: { invoke: async () => null } } as unknown as AccountClient;
    await expect(encryptedRulesSync(root, client)).rejects.toThrow("base is missing");
    expect(refreshVault).not.toHaveBeenCalled(); expect(captureRulesFiles()).toEqual(before);
  });
});
describe("three-way global rules merge", () => {
  const state = (value: Record<string, string>, device = "device") => decodeRulesFiles(files(value), device);
  it("combines independent edits, preserves deletions and ignores clocks", () => {
    const base = state({ a: "old", b: "old" });
    const merged = mergeRules(base, state({ a: "new", b: "old" }), state({ a: "old", b: "remote" }));
    expect(conflictsIn(merged)).toHaveLength(0); expect(merged.get("a")![0]!.bytes!.toString()).toContain("new");
    expect(mergeRules(base, state({ b: "old" }), base).has("a")).toBe(false);
  });
  it("converges reversed conflicts and adds variants without nesting", () => {
    const base = state({ a: "old" }), a = state({ a: "A" }, "A"), b = state({ a: "B" }, "B");
    const ab = mergeRules(base, a, b), ba = mergeRules(base, b, a);
    expect(encodeRulesFiles(ab)).toEqual(encodeRulesFiles(ba));
    expect(mergeRules(base, ab, state({ a: "C" }, "C")).get("a")).toHaveLength(3);
    expect(decodeRulesFiles(encodeRulesFiles(ab))).toEqual(ab);
    expect(mergeRules(base, a, new Map()).get("a")!.some(v => v.hash === "deleted")).toBe(true);
  });
  it("does not resurrect a remote addition deleted during a publication retry", () => {
    const base = state({ q: "old" }), local = state({ q: "edited" });
    const firstCandidate = mergeRules(base, local, state({ q: "old", r: "new remote rule" }));
    expect(firstCandidate.has("r")).toBe(true);
    const retry = mergeRules(base, local, state({ q: "old" })); expect(retry.has("r")).toBe(false);
  });
  it("suspends conflicts and resolves only the expected state", async () => {
    const { root, project } = setup(); await createRule({ title: "Initialize", body: "Manual." });
    const conflict = mergeRules(state({ a: "base" }), state({ a: "left" }), state({ a: "right" }));
    replaceRulesFiles(root, filesRevision(captureRulesFiles(root)), encodeRulesFiles(conflict));
    const item = listRules().conflicts[0]!; expect(getApplicableRules(project, { ids: [item.id] }).rules).toHaveLength(0);
    await expect(resolveRuleConflict(item.id, { conflictId: "stale", expectedStateHash: stateHash(conflict.get(item.id)), variant: item.variants[0]!.hash })).rejects.toThrow("changed");
    await resolveRuleConflict(item.id, { conflictId: item.conflictId, expectedStateHash: stateHash(conflict.get(item.id)), variant: item.variants[0]!.hash });
    expect(listRules().conflicts).toHaveLength(0); expect(listRules().rules).toHaveLength(1);
  });
  it("rejects secret variants and orphaned files on export", () => { const map = files({ a: "safe" }); map.set("rules/a.md", Buffer.from(rule("a", "safe").replace("safe", "API_KEY=bad"))); expect(() => decodeRulesFiles(map)).toThrow("secret"); expect(() => decodeRulesFiles(new Map([["rules/backup.txt", Buffer.from("extra")]]))).toThrow("Unsupported"); });
});
