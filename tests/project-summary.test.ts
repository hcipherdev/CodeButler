import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import {
  initializeProjectSummary,
  installProjectSummary,
  readProjectBrief,
  refreshProjectSummary,
  refreshProjectSummaryIfDue,
  getProjectSummaryStatus,
  type ProjectSummaryGenerator
} from "../src/project-summary/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("project narrative summary", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createProject(): {
    rootDir: string;
    generator: ProjectSummaryGenerator;
    outputs: string[];
  } {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "Cargo.toml"), '[workspace]\nmembers = ["crates/crypto"]\n');
    writeFileSync(join(rootDir, "README.md"), "# Example Project\nCurrent README truth.\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "# Old Agents\nstale agent instructions\n");
    writeFileSync(join(rootDir, "CLAUDE.md"), "# Old Claude\nstale claude instructions\n");
    writeFileSync(join(rootDir, "src", "lib.rs"), "pub fn encrypt() {}\n");
    ensureProjectConfig(rootDir);
    const outputs: string[] = [];
    const generator: ProjectSummaryGenerator = {
      async generate(input) {
        outputs.push(input.fingerprint);
        return [
          "# Project Brief",
          "",
          `Project root: ${input.projectRoot}`,
          `Hints: ${input.agentHints.length}`,
          "Purpose: Generated from verified code context.",
          "Use Butler tools for detailed memories."
        ].join("\n");
      }
    };
    return { rootDir, generator, outputs };
  }

  it("installs a generated summary and replaces agent files after timestamped backup", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await installProjectSummary(store, config, { generator, now: () => new Date("2026-06-16T10:00:00Z") });

    expect(result.generated).toBe(true);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(true);
    expect(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8")).toContain("# Project Brief");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("summarize_project_brief");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("summarize_active_context");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("search_temporary_memory");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("summarize_recent_activity");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("git only as secondary corroboration");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).not.toContain("stale agent instructions");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("sync_project_memory");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("where were we?");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("what changed recently and why");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("last 3 days");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("global Code Butler MCP server named `code-butler`");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("current_project");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).not.toContain("project-scoped Code Butler MCP tools");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).not.toContain("may be named `code-butler`");
    expect(readFileSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toContain("stale agent instructions");
    expect(readFileSync(join(rootDir, "CLAUDE.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toContain("stale claude instructions");
    expect(getProjectSummaryStatus(rootDir).exists).toBe(true);
    store.close();
  });

  it("creates missing agent files without requiring backups", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, "README.md"), "# Project\n");
    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const result = await installProjectSummary(store, config, {
      generator: {
        async generate() {
          return "# Project Brief\n";
        }
      },
      now: () => new Date("2026-06-16T10:00:00Z")
    });

    expect(result.backupDir).toBeUndefined();
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("Code Butler");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("Code Butler");
    store.close();
  });

  it("refreshes only when inputs changed unless forced", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-16T00:00:00Z") });
    const before = statSync(join(rootDir, ".code-butler", "project-summary.md")).mtimeMs;
    const quiet = await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-16T01:00:00Z") });

    expect(quiet.generated).toBe(false);
    expect(statSync(join(rootDir, ".code-butler", "project-summary.md")).mtimeMs).toBe(before);
    writeFileSync(join(rootDir, "README.md"), "# Example Project\nChanged README truth.\n");
    const changed = await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-16T02:00:00Z") });

    expect(changed.generated).toBe(true);
    expect(outputs).toHaveLength(2);
    store.close();
  });

  it("daily gated refresh updates checked metadata without rewriting quiet summaries", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-15T00:00:00Z") });
    const before = readProjectBrief(rootDir);
    const quiet = await refreshProjectSummaryIfDue(store, config, {
      generator,
      now: () => new Date("2026-06-16T00:00:00Z")
    });
    const after = readProjectBrief(rootDir);

    expect(quiet.checked).toBe(true);
    expect(quiet.generated).toBe(false);
    expect(after.summary).toBe(before.summary);
    expect(after.meta?.lastCheckedAt).toBe("2026-06-16T00:00:00.000Z");
    store.close();
  });

  it("does not treat installed bootstrap files as a meaningful summary input change", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    await installProjectSummary(store, config, { generator, now: () => new Date("2026-06-15T00:00:00Z") });
    const quiet = await refreshProjectSummaryIfDue(store, config, {
      generator,
      now: () => new Date("2026-06-16T00:00:00Z")
    });

    expect(quiet.generated).toBe(false);
    expect(outputs).toHaveLength(1);
    store.close();
  });

  it("explicit initialization is idempotent after bootstraps are current", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    const first = await initializeProjectSummary(store, config, {
      generator,
      now: () => new Date("2026-06-15T00:00:00Z")
    });
    const second = await initializeProjectSummary(store, config, {
      generator,
      now: () => new Date("2026-06-16T00:00:00Z")
    });

    expect(first.backupDir).toBe(rootDir);
    expect(second.backupDir).toBeUndefined();
    expect(readFileSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-15T00-00-00-000Z"), "utf8")).toContain("stale agent instructions");
    expect(existsSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T00-00-00-000Z"))).toBe(false);
    store.close();
  });
});
