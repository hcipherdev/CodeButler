import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LEGACY_GLOBAL_RULES_INSTRUCTIONS } from "../src/rules/match.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp.js";
import { handleDesktopRequest } from "../src/desktop/service.js";
import { rulesDesktopList } from "../src/rules/desktop.js";
import { listRules } from "../src/rules/store.js";
import { globalRulesRoot } from "../src/rules/identity.js";
import { agentBootstrapText, legacyAgentBootstrapText, upgradeAgentBootstraps } from "../src/project-summary/service.js";

const directories: string[] = [];
const temp = () => { const root = makeTempDir(); directories.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) cleanupTempDir(root); });
describe("global rules desktop contract", () => {
  it("authors manually without a selected project and rejects concurrent stale mutations", async () => {
    vi.stubEnv("CODE_BUTLER_HOME", temp());
    const before = rulesDesktopList();
    const created = await handleDesktopRequest({ version: 1, action: "rules.create", expectedRevision: before.revision, input: { title: "Manual coding rule", body: "Use clear names." } });
    expect(created).toMatchObject({ title: "Manual coding rule" });
    const rule = listRules().rules[0]!;
    const results = await Promise.allSettled(["First edit", "Second edit"].map(body => handleDesktopRequest({ version: 1, action: "rules.update", id: rule.id, expectedHash: rule.contentHash, patch: { body } })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "stale-rule" } });
    await expect(handleDesktopRequest({ version: 1, action: "rules.create", expectedRevision: before.revision, input: { title: "Old collection", body: "Draft preserved in UI." } })).rejects.toMatchObject({ code: "stale-rule" });
    const current = listRules().rules[0]!;
    await handleDesktopRequest({ version: 1, action: "rules.set-enabled", id: current.id, expectedHash: current.contentHash, enabled: false });
    expect(listRules().rules[0]!.enabled).toBe(false);
    await expect(handleDesktopRequest({ version: 1, action: "projects.add", root: globalRulesRoot(), initialize: true })).rejects.toThrow();
    await handleDesktopRequest({ version: 1, action: "rules.delete", id: current.id, expectedHash: listRules().rules[0]!.contentHash });
    expect(listRules().rules).toHaveLength(0);
  });
  it("requires explicit sync consent and starts the watcher when enabled", async () => {
    vi.stubEnv("CODE_BUTLER_HOME", temp());
    const setRulesSyncEnabled = vi.fn(async () => undefined), ensureGlobalWatcher = vi.fn();
    await expect(handleDesktopRequest({ version: 1, action: "rules.sync.set-enabled", enabled: true, expectedHash: null }, { setRulesSyncEnabled, ensureGlobalWatcher })).rejects.toMatchObject({ code: "confirmation-required" });
    expect(setRulesSyncEnabled).not.toHaveBeenCalled();
    await handleDesktopRequest({ version: 1, action: "rules.sync.set-enabled", enabled: true, expectedHash: null, confirmed: true }, { setRulesSyncEnabled, ensureGlobalWatcher });
    expect(setRulesSyncEnabled).toHaveBeenCalledWith(true, undefined, null); expect(ensureGlobalWatcher).toHaveBeenCalledOnce();
  });
});
describe("managed bootstrap upgrade", () => {
  it("upgrades verified version 2 guidance with a backup and retains surrounding user text", () => {
    const root = temp();
    const content = legacyAgentBootstrapText("AGENTS.md") + "\n## Global Rules\n- " + LEGACY_GLOBAL_RULES_INSTRUCTIONS + "\n";
    const hash = createHash("sha256").update(content).digest("hex");
    const original = `User introduction.\n<!-- code-butler:begin v=2 sha256=${hash} -->\n${content}<!-- code-butler:end -->\nUser instructions.\n`;
    writeFileSync(join(root, "AGENTS.md"), original);
    const result = upgradeAgentBootstraps(root);
    expect(result.backupFiles).toHaveLength(1); expect(readFileSync(result.backupFiles[0]!, "utf8")).toBe(original);
    const updated = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(updated).toContain("User introduction."); expect(updated).toContain("User instructions.");
    expect(updated).toContain("v=3"); expect(updated).toContain("Optional desktop AI assistance");
    writeFileSync(join(root, "AGENTS.md"), original.replace("Global rules are manually authored", "Custom authoring policy"));
    expect(upgradeAgentBootstraps(root).customized).toEqual(["AGENTS.md"]);
  });
  it("backs up exact historical templates and preserves customized content", () => {
    const root = temp(); mkdirSync(join(root, ".code-butler"));
    const old = legacyAgentBootstrapText("AGENTS.md"), customized = legacyAgentBootstrapText("CLAUDE.md") + "\nMy convention: custom tools.\n";
    writeFileSync(join(root, "AGENTS.md"), old); writeFileSync(join(root, "CLAUDE.md"), customized);
    const result = upgradeAgentBootstraps(root);
    expect(result.customized).toEqual(["CLAUDE.md"]); expect(result.backupFiles).toHaveLength(1);
    expect(readFileSync(result.backupFiles[0]!, "utf8")).toBe(old);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("get_applicable_rules");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(customized);
    expect(upgradeAgentBootstraps(root, result.agentFiles).backupFiles).toHaveLength(0);
  });
  it("retains content outside verified blocks and refuses modified generated text", () => {
    const root = temp();
    const text = "My introduction.\n" + agentBootstrapText("AGENTS.md") + "\nMy project rules.\n";
    writeFileSync(join(root, "AGENTS.md"), text);
    expect(upgradeAgentBootstraps(root).customized).toEqual([]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(text);
    const altered = text.replace("Global rules require user approval", "Let agents author global rules");
    writeFileSync(join(root, "AGENTS.md"), altered);
    expect(upgradeAgentBootstraps(root).customized).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(altered);
  });
});
