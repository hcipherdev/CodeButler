import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureProjectConfig } from "../src/config.js";
import { markProjectRemoved } from "../src/cloud/removal-state.js";
import { readProjectOperationStatus, withProjectGate } from "../src/cloud/gate.js";
import { readCurrentProjectInfo } from "../src/mcp/tools.js";
import { createProjectMemoryServer, closeProjectMemoryServer } from "../src/server.js";
import { inspectDesktopProject } from "../src/desktop/inspection.js";
import { handleDesktopRequest } from "../src/desktop/service.js";
import { runDoctor } from "../src/doctor/service.js";
import { initializeProjectMemory } from "../src/project-initialization.js";
import { ensureAutomaticProjectSetup, enrichLocalProjectSummary, readProjectSetupStatus } from "../src/project-setup.js";
import { readProjectBrief } from "../src/project-summary/service.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp.js";
import { serializeRule } from "../src/rules/format.js";

describe("automatic project setup", () => {
  let directory: string;
  let root: string;
  beforeEach(() => {
    directory = makeTempDir(); root = join(directory, "project"); mkdirSync(root);
    const home = join(directory, "home"); mkdirSync(home);
    vi.stubEnv("CODE_BUTLER_HOME", home);
    vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", "legacy");
    writeFileSync(join(home, "config.json"), "{}");
    ensureProjectConfig(root);
    writeFileSync(join(root, ".code-butler/config.json"), JSON.stringify({
      sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } },
      sync: { autoSyncOnServerStart: false },
      extractor: { enabled: false, apiKeyEnv: "BUTLER_SETUP_TEST_MISSING_KEY" }, investigator: { enabled: false }
    }));
    delete process.env.BUTLER_SETUP_TEST_MISSING_KEY;
  });
  afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });

  it("creates every setup artifact in a folder with no Butler storage", async () => {
    const fresh = join(directory, "fresh"); mkdirSync(fresh);
    const result = await ensureAutomaticProjectSetup(fresh);
    expect(result).toMatchObject({ status: "ready", missing: [], summaryQuality: "local" });
    for (const file of ["config.json", "memory.sqlite", "project-summary.md", "setup.meta.json"]) {
      expect(existsSync(join(fresh, ".code-butler", file))).toBe(true);
    }
  });

  it("completes local setup without ingestion or credentials and leaves reconnects unchanged", async () => {
    const first = await ensureAutomaticProjectSetup(root);
    expect(first).toMatchObject({ status: "ready", missing: [], summaryQuality: "local" });
    const files = ["AGENTS.md", "CLAUDE.md", ".code-butler/project-summary.md", ".code-butler/setup.meta.json"];
    const times = files.map(file => statSync(join(root, file)).mtimeMs);
    await ensureAutomaticProjectSetup(root);
    await enrichLocalProjectSummary(root);
    expect(files.map(file => statSync(join(root, file)).mtimeMs)).toEqual(times);
    // Local setup writes the local generator's text into the fixed summary sections.
    expect(readProjectBrief(root).summary).toContain("Check the project issue tracker and current work for open questions.");
    expect(inspectDesktopProject(root)).toMatchObject({ status: "ready", missing: [] });
  });

  it("repairs the CipherScope case without changing a manual summary or stored memory", async () => {
    const store = openConfiguredMemoryStore(root); store.init();
    rememberProjectMemory(store, { type: "decision", title: "Keep this", text: "Keep project history during setup repair." });
    store.close();
    const summary = join(root, ".code-butler/project-summary.md");
    writeFileSync(summary, "# My manually written summary\n");
    const before = statSync(summary).mtimeMs;
    expect(inspectDesktopProject(root)).toMatchObject({ status: "needs-init", missing: ["AGENTS.md", "CLAUDE.md"] });
    expect(runDoctor(root).checks.find(check => check.id === "project:setup")).toMatchObject({ status: "warning" });
    await ensureAutomaticProjectSetup(root);
    expect(statSync(summary).mtimeMs).toBe(before);
    expect(readFileSync(summary, "utf8")).toBe("# My manually written summary\n");
    const repaired = openConfiguredMemoryStore(root); repaired.init();
    expect(repaired.getProjectSummary().promotedMemories).toBe(1); repaired.close();
  });

  it("desktop completion handles missing agent files with an existing summary", async () => {
    await ensureAutomaticProjectSetup(root);
    unlinkSync(join(root, "AGENTS.md")); unlinkSync(join(root, "CLAUDE.md"));
    const before = readProjectBrief(root).summary;
    expect(await handleDesktopRequest({ version: 1, action: "projects.inspect", root })).toMatchObject({ status: "needs-init", missing: ["AGENTS.md", "CLAUDE.md"] });
    const added = await handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, { ensureGlobalWatcher: () => {} });
    expect(added).toMatchObject({ initialized: true });
    expect(readProjectBrief(root).summary).toBe(before);
  });

  it("preserves customized agent files and reports skipped upgrades while repairing missing files", async () => {
    writeFileSync(join(root, "AGENTS.md"), "Original project rules\n");
    writeFileSync(join(root, "CLAUDE.md"), "Original Claude rules\n");
    const setup = await ensureAutomaticProjectSetup(root);
    expect(setup.backupFiles).toHaveLength(0);
    expect(setup.customizedAgentFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Original project rules\n");
    writeFileSync(join(root, "AGENTS.md"), "Later user edits\n");
    unlinkSync(join(root, "CLAUDE.md"));
    await ensureAutomaticProjectSetup(root);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Later user edits\n");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(readdirSync(root).filter(file => file.includes("code-butler-backup"))).toHaveLength(0);
  });

  it("repairs empty artifacts and serializes concurrent completion without duplicate backups", async () => {
    ensureProjectConfig(root);
    writeFileSync(join(root, ".code-butler/project-summary.md"), "");
    writeFileSync(join(root, "AGENTS.md"), "Original\n");
    await Promise.all([ensureAutomaticProjectSetup(root), ensureAutomaticProjectSetup(root)]);
    expect(readProjectSetupStatus(root).status).toBe("ready");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Original\n");
    expect(readdirSync(root).filter(file => file.includes("code-butler-backup"))).toHaveLength(0);
    writeFileSync(join(root, "CLAUDE.md"), "");
    await ensureAutomaticProjectSetup(root);
    expect(readProjectSetupStatus(root).status).toBe("ready");
  });

  it("rolls back installation failure and resumes on the next connection", async () => {
    writeFileSync(join(root, "AGENTS.md"), "Original\n");
    await expect(ensureAutomaticProjectSetup(root, { bootstrapApplyFile() { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    expect(readProjectSetupStatus(root)).toMatchObject({ status: "failed" });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Original\n");
    expect(existsSync(join(root, ".code-butler/project-summary.md"))).toBe(false);
    expect(readdirSync(root).filter(file => file.includes("code-butler-backup"))).toHaveLength(0);
    await ensureAutomaticProjectSetup(root);
    expect(readProjectSetupStatus(root).status).toBe("ready");
  });

  it("preserves a manual summary edited while bootstrap installation fails", async () => {
    const path = join(root, ".code-butler/project-summary.md"); writeFileSync(path, "# Original manual summary\n");
    await expect(ensureAutomaticProjectSetup(root, { bootstrapApplyFile() {
      writeFileSync(path, "# User edit during failed setup\n"); throw new Error("disk full");
    } })).rejects.toThrow("disk full");
    expect(readFileSync(path, "utf8")).toBe("# User edit during failed setup\n");
  });

  it("preserves a summary that appears while initial generation is running", async () => {
    const path = join(root, ".code-butler/project-summary.md");
    await ensureAutomaticProjectSetup(root, { generator: { async generate() {
      writeFileSync(path, "# User-written summary\n"); return "# Generated summary";
    } } });
    expect(readFileSync(path, "utf8")).toBe("# User-written summary\n");
    expect(readProjectSetupStatus(root)).toMatchObject({ status: "ready", summaryQuality: "existing" });
  });

  it("rejects non-file destinations and respects deliberate memory removal", async () => {
    const invalid = join(directory, "invalid"); mkdirSync(invalid); mkdirSync(join(invalid, "AGENTS.md"));
    await expect(ensureAutomaticProjectSetup(invalid)).rejects.toThrow("regular file");
    expect(existsSync(join(invalid, ".code-butler/config.json"))).toBe(false);
    const removed = join(directory, "removed"); mkdirSync(removed); markProjectRemoved(removed);
    await expect(ensureAutomaticProjectSetup(removed)).rejects.toThrow("removed");
    expect(existsSync(join(removed, ".code-butler"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")("rejects dangling agent symlinks without touching their targets", async () => {
    const target = join(directory, "outside.md"); symlinkSync(target, join(root, "CLAUDE.md"));
    await expect(ensureAutomaticProjectSetup(root)).rejects.toThrow("regular file");
    expect(existsSync(target)).toBe(false);
  });

  it("explicit initialization records completion so MCP preserves subsequent edits", async () => {
    await initializeProjectMemory(root, { generator: { async generate() { return "# Explicit summary"; } } });
    writeFileSync(join(root, "AGENTS.md"), "Later instructions\n");
    await ensureAutomaticProjectSetup(root);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Later instructions\n");
  });

  it("enriches outside the gate and does not repeat paid work once complete", async () => {
    await ensureAutomaticProjectSetup(root);
    const generator = { name: "test-provider", generate: vi.fn(async () => {
      expect(readProjectOperationStatus(root)).toBeUndefined();
      expect(readCurrentProjectInfo(root).setup.status).toBe("ready");
      return "# Rich summary";
    }) };
    await enrichLocalProjectSummary(root, { enrichmentGenerator: generator });
    expect(readProjectSetupStatus(root)).toMatchObject({ status: "ready", summaryQuality: "provider", enrichment: { status: "complete" } });
    await enrichLocalProjectSummary(root, { enrichmentGenerator: generator });
    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("keeps manual edits made during enrichment and discards stale project inputs", async () => {
    await ensureAutomaticProjectSetup(root);
    await enrichLocalProjectSummary(root, { enrichmentGenerator: { async generate() {
      writeFileSync(join(root, ".code-butler/project-summary.md"), "# Edited during generation\n");
      return "# Stale provider summary";
    } } });
    expect(readProjectBrief(root).summary).toBe("# Edited during generation\n");
    const other = join(directory, "other"); mkdirSync(other);
    execFileSync("git", ["init"], { cwd: other });
    writeFileSync(join(other, "README.md"), "# Original\n"); execFileSync("git", ["add", "README.md"], { cwd: other });
    await ensureAutomaticProjectSetup(other);
    const original = readProjectBrief(other).summary;
    await enrichLocalProjectSummary(other, { enrichmentGenerator: { async generate() {
      writeFileSync(join(other, "README.md"), "# Changed during generation\n"); return "# Stale";
    } } });
    expect(readProjectBrief(other).summary).toBe(original);
  });

  it("preserves an edit made immediately before the enriched summary commit", async () => {
    await ensureAutomaticProjectSetup(root);
    await expect(enrichLocalProjectSummary(root, {
      enrichmentGenerator: { async generate() { return "# Provider summary"; } },
      summaryBeforeCommit(path) { writeFileSync(path, "# Last-moment edit\n"); }
    })).rejects.toThrow();
    expect(readProjectBrief(root).summary).toBe("# Last-moment edit\n");
  });

  it("retains a usable local summary after provider failure and enforces daily retry across reconnects", async () => {
    await ensureAutomaticProjectSetup(root);
    const generate = vi.fn(async () => { throw new Error("provider unavailable"); });
    const generator = { generate };
    const first = () => new Date("2026-09-27T10:00:00Z");
    await expect(enrichLocalProjectSummary(root, { enrichmentGenerator: generator, now: first })).rejects.toThrow("provider unavailable");
    await ensureAutomaticProjectSetup(root);
    await enrichLocalProjectSummary(root, { enrichmentGenerator: generator, now: first });
    expect(generate).toHaveBeenCalledOnce();
    expect(readProjectSetupStatus(root)).toMatchObject({ status: "ready", summaryQuality: "local", enrichment: { status: "failed" } });
    await expect(enrichLocalProjectSummary(root, { enrichmentGenerator: generator, now: () => new Date("2026-09-28T10:00:01Z") })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("cancels enrichment and permits retry after restart", async () => {
    await ensureAutomaticProjectSetup(root);
    const abort = new AbortController();
    await enrichLocalProjectSummary(root, { signal: abort.signal, enrichmentGenerator: { async generate() {
      abort.abort(); return "## What this is\nCancelled summary.";
    } } });
    expect(readProjectSetupStatus(root)).toMatchObject({ summaryQuality: "local", enrichment: { status: "idle" } });
    await enrichLocalProjectSummary(root, { enrichmentGenerator: { async generate() { return "## What this is\nRetried summary."; } } });
    expect(readProjectBrief(root).summary).toContain("Retried summary.");
    expect(readProjectBrief(root).summary).not.toContain("Cancelled summary.");
  });

  it("leaves status queries readable while another operation holds the gate", async () => {
    await ensureAutomaticProjectSetup(root);
    await withProjectGate(root, async () => {
      expect(readCurrentProjectInfo(root).setup.status).toBe("ready");
    });
  });

  it("defers automatic setup until startup work, even with startup ingestion disabled", async () => {
    const server = await createProjectMemoryServer({ rootDir: root, deferStartupSync: true });
    try {
      expect(readProjectSetupStatus(root).status).toBe("pending");
      await server.startupSync?.();
      expect(readProjectSetupStatus(root).status).toBe("ready");
      expect(server.store.getProjectSummary().sources).toBe(0);
    } finally { await closeProjectMemoryServer(server); }
  });

  it("supports the explicit opt-out", async () => {
    const server = await createProjectMemoryServer({ rootDir: root, autoInit: false });
    try { expect(existsSync(join(root, "AGENTS.md"))).toBe(false); expect(existsSync(join(root, ".code-butler/project-summary.md"))).toBe(false); }
    finally { await closeProjectMemoryServer(server); }
  });

  it.each(["legacy", "published"])("completes setup through a real %s MCP connection without desktop", async engine => {
    const rulesDirectory = join(directory, "home/global/.code-butler/rules"); mkdirSync(rulesDirectory, { recursive: true });
    writeFileSync(join(rulesDirectory, "debug.md"), serializeRule({ schemaVersion: 1, id: "debug", title: "Debug docs", body: "Store debug notes in docs/debug/.", triggers: { actions: ["create_doc"] } }));
    const client = new Client({ name: "setup-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "mcp", "--project-root", root],
      env: { ...process.env as Record<string, string>, CODE_BUTLER_HOME: join(directory, "home"), CODE_BUTLER_RETRIEVAL_ENGINE: engine }, stderr: "pipe"
    });
    const errors: string[] = []; transport.stderr?.on("data", data => errors.push(String(data)));
    try {
      await client.connect(transport);
      await vi.waitFor(() => expect(readProjectSetupStatus(root).status).toBe("ready"), { timeout: 60_000 });
      const info = await client.callTool({ name: "current_project", arguments: {} });
      expect(JSON.parse((info.content as { text: string }[])[0]!.text).setup).toMatchObject({ status: "ready", missing: [] });
      const brief = await client.callTool({ name: "summarize_project_brief", arguments: {} });
      expect(JSON.parse((brief.content as { text: string }[])[0]!.text).summary).toContain("Check the project issue tracker and current work for open questions.");
      expect(JSON.parse((brief.content as { text: string }[])[0]!.text).globalRules.catalog.rules).toMatchObject([{ id: "debug" }]);
      const tools = await client.listTools();
      expect(tools.tools.filter(tool => tool.name.includes("rule")).map(tool => [tool.name, tool.annotations?.readOnlyHint])).toEqual([["get_applicable_rules", true], ["record_rule_attestation", false]]);
      const match = await client.callTool({ name: "get_applicable_rules", arguments: { actions: ["create_doc"] } });
      expect(JSON.parse((match.content as { text: string }[])[0]!.text).rules).toMatchObject([{ id: "debug", body: "Store debug notes in docs/debug/." }]);
      const other = await client.callTool({ name: "get_applicable_rules", arguments: { actions: ["run_tests"] } });
      expect(JSON.parse((other.content as { text: string }[])[0]!.text).rules).toEqual([]);
      expect(existsSync(join(rulesDirectory, "../memory.sqlite"))).toBe(false);
    } finally { await client.close(); }
  }, 120_000);

  it.each(["legacy", "published"])("keeps %s MCP responsive during enrichment and stops provider work on shutdown", async engine => {
    let requested = false;
    let closed = false;
    const provider = createServer((request, response) => {
      requested = true; request.resume(); response.on("close", () => { closed = true; });
      // Deliberately keep the provider response pending until the client shuts down.
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address() as { port: number };
    const configPath = join(root, ".code-butler/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.extractor = { enabled: false, provider: "openai-compatible", model: "test", apiKeyEnv: "BUTLER_SETUP_TEST_MISSING_KEY", baseUrl: `http://127.0.0.1:${address.port}` };
    writeFileSync(configPath, JSON.stringify(config));
    const client = new Client({ name: "slow-provider-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp", "--project-root", root],
      env: { ...process.env as Record<string, string>, CODE_BUTLER_HOME: join(directory, "home"), CODE_BUTLER_RETRIEVAL_ENGINE: engine, BUTLER_SETUP_TEST_MISSING_KEY: "test-only" }, stderr: "pipe"
    });
    try {
      await client.connect(transport);
      await vi.waitFor(() => expect(requested).toBe(true), { timeout: 20_000 });
      const info = await client.callTool({ name: "current_project", arguments: {} });
      expect(JSON.parse((info.content as { text: string }[])[0]!.text).setup).toMatchObject({ status: "ready", summaryQuality: "local", enrichment: { status: "running" } });
      const brief = await client.callTool({ name: "summarize_project_brief", arguments: {} });
      expect(JSON.parse((brief.content as { text: string }[])[0]!.text).summary).toContain("Check the project issue tracker and current work for open questions.");
      await client.close();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 10_000 });
    } finally {
      await client.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  }, 45_000);
});
