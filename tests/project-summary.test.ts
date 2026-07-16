import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import {
  initializeProjectSummary,
  installProjectSummary,
  collectProjectSummaryInput,
  readProjectBrief,
  refreshProjectSummary,
  refreshProjectSummaryIfDue,
  getProjectSummaryStatus,
  type ProjectSummaryGenerator,
  type ProjectSummaryGeneratorInput
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
    inputs: ProjectSummaryGeneratorInput[];
  } {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "Cargo.toml"), '[workspace]\nmembers = ["crates/crypto"]\n');
    writeFileSync(join(rootDir, "README.md"), "# Example Project\nCurrent README truth.\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "# Old Agents\nstale agent instructions\n");
    writeFileSync(join(rootDir, "CLAUDE.md"), "# Old Claude\nstale claude instructions\n");
    writeFileSync(join(rootDir, "src", "lib.rs"), "pub fn encrypt() {}\n");
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "--all"]);
    ensureProjectConfig(rootDir);
    const outputs: string[] = [];
    const inputs: ProjectSummaryGeneratorInput[] = [];
    const generator: ProjectSummaryGenerator = {
      async generate(input) {
        inputs.push(input);
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
    return { rootDir, generator, outputs, inputs };
  }

  function git(rootDir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
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
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "README.md"]);
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

  it("does not replace or back up agent files when installation generation fails", async () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);

    await expect(
      installProjectSummary(store, config, {
        generator: {
          async generate() {
            throw new Error("generation failed");
          }
        },
        now: () => new Date("2026-06-16T10:00:00Z")
      })
    ).rejects.toThrow("generation failed");

    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("stale agent instructions");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("stale claude instructions");
    expect(existsSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    store.close();
  });

  it.runIf(sep === "/")("rejects an external bootstrap symlink before generation or writes", async () => {
    const { rootDir } = createProject();
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const victimPath = join(outsideDir, "victim.md");
    writeFileSync(victimPath, "external victim\n");
    rmSync(join(rootDir, "AGENTS.md"));
    symlinkSync(victimPath, join(rootDir, "AGENTS.md"));
    const store = openMemoryStore(rootDir);
    store.init();
    let generated = false;

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), {
      generator: {
        async generate() {
          generated = true;
          return "# Must not be generated\n";
        }
      }
    })).rejects.toThrow(/AGENTS\.md/);

    expect(generated).toBe(false);
    expect(readFileSync(victimPath, "utf8")).toBe("external victim\n");
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.meta.json"))).toBe(false);
    store.close();
  });

  it.runIf(sep === "/")("rejects a summary symlink before refresh generation or external writes", async () => {
    const { rootDir } = createProject();
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const victimPath = join(outsideDir, "summary-victim.md");
    writeFileSync(victimPath, "external summary victim\n");
    symlinkSync(victimPath, join(rootDir, ".code-butler", "project-summary.md"));
    const store = openMemoryStore(rootDir);
    store.init();
    let generated = false;

    await expect(refreshProjectSummary(store, loadProjectConfig(rootDir), {
      force: true,
      generator: {
        async generate() {
          generated = true;
          return "# Must not be generated\n";
        }
      }
    })).rejects.toThrow(/project-summary\.md/);

    expect(generated).toBe(false);
    expect(readFileSync(victimPath, "utf8")).toBe("external summary victim\n");
    store.close();
  });

  it.runIf(sep === "/")("rejects a metadata symlink before install generation or external writes", async () => {
    const { rootDir } = createProject();
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const victimPath = join(outsideDir, "meta-victim.json");
    writeFileSync(victimPath, "external metadata victim\n");
    symlinkSync(victimPath, join(rootDir, ".code-butler", "project-summary.meta.json"));
    const store = openMemoryStore(rootDir);
    store.init();
    let generated = false;

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), {
      generator: {
        async generate() {
          generated = true;
          return "# Must not be generated\n";
        }
      }
    })).rejects.toThrow(/project-summary\.meta\.json/);

    expect(generated).toBe(false);
    expect(readFileSync(victimPath, "utf8")).toBe("external metadata victim\n");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("stale agent instructions");
    store.close();
  });

  it("rejects a non-file bootstrap destination without leaving summary state", async () => {
    const { rootDir, generator } = createProject();
    rmSync(join(rootDir, "CLAUDE.md"));
    mkdirSync(join(rootDir, "CLAUDE.md"));
    const store = openMemoryStore(rootDir);
    store.init();

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), { generator }))
      .rejects.toThrow(/CLAUDE\.md/);

    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.meta.json"))).toBe(false);
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("stale agent instructions");
    store.close();
  });

  it("rolls back summaries, backups, and the first bootstrap when the second apply fails", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const timestamp = "2026-06-16T10-00-00-000Z";
    const agentsBackup = join(rootDir, `AGENTS.md.code-butler-backup-${timestamp}`);
    const claudeBackup = join(rootDir, `CLAUDE.md.code-butler-backup-${timestamp}`);
    writeFileSync(agentsBackup, "preexisting agents backup\n");
    writeFileSync(claudeBackup, "preexisting claude backup\n");

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), {
      generator,
      now: () => new Date("2026-06-16T10:00:00Z"),
      bootstrapApplyFile(stagedPath: string, destinationPath: string) {
        if (destinationPath.endsWith("CLAUDE.md")) throw new Error("injected second apply failure");
        renameSync(stagedPath, destinationPath);
      }
    })).rejects.toThrow("injected second apply failure");

    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("stale agent instructions");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("stale claude instructions");
    expect(readFileSync(agentsBackup, "utf8")).toBe("preexisting agents backup\n");
    expect(readFileSync(claudeBackup, "utf8")).toBe("preexisting claude backup\n");
    expect(readdirSync(rootDir).filter((path) => path.includes(timestamp))).toEqual([
      `AGENTS.md.code-butler-backup-${timestamp}`,
      `CLAUDE.md.code-butler-backup-${timestamp}`
    ]);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.meta.json"))).toBe(false);
    store.close();
  });

  it("preserves a same-inode bootstrap edit made while the generator is running", async () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), {
      generator: {
        async generate() {
          writeFileSync(join(rootDir, "AGENTS.md"), "concurrent user edit\n");
          return "# Generated summary\n";
        }
      }
    })).rejects.toThrow(/changed during install/);

    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toBe("concurrent user edit\n");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("stale claude instructions");
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.meta.json"))).toBe(false);
    store.close();
  });

  it("restores absent summary state when metadata writing fails after generation", async () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const metaPath = join(rootDir, ".code-butler", "project-summary.meta.json");

    await expect(installProjectSummary(store, loadProjectConfig(rootDir), {
      generator: {
        async generate() {
          mkdirSync(metaPath);
          return "# Generated summary\n";
        }
      }
    })).rejects.toThrow();

    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("stale agent instructions");
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

  it("includes user-owned notes in the input fingerprint without changing their bytes", async () => {
    const { rootDir, generator, inputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const notesPath = join(rootDir, ".code-butler", "project-summary-notes.md");
    const notes = `# Maintainer notes\n${"n".repeat(20_100)}tail-one\n`;
    writeFileSync(notesPath, notes);

    const before = collectProjectSummaryInput(store, config);
    await refreshProjectSummary(store, config, { generator });
    await refreshProjectSummary(store, config, { generator, force: true });

    expect(inputs[0]?.notes?.content).toContain("# Maintainer notes");
    expect(inputs[0]?.notes?.truncated).toBe(true);
    expect(inputs[0]?.notes?.originalBytes).toBe(Buffer.byteLength(notes));
    expect(readFileSync(notesPath, "utf8")).toBe(notes);

    writeFileSync(notesPath, notes.replace("tail-one", "tail-two"));
    const after = collectProjectSummaryInput(store, config);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    store.close();
  });

  it("refuses to overwrite manual summary edits during normal refresh", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");

    const first = await refreshProjectSummary(store, config, { generator });
    expect(first.meta?.outputContentHash).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(summaryPath, "# Manual project brief\nKeep this edit.\n");
    writeFileSync(join(rootDir, "README.md"), "# Example Project\nChanged input.\n");

    const result = await refreshProjectSummary(store, config, { generator });
    const status = getProjectSummaryStatus(rootDir, { store, config });

    expect(result.generated).toBe(false);
    expect(result.skippedReason).toBe("manual_edits_detected");
    expect(result.manualEditsDetected).toBe(true);
    expect(status.manualEditsDetected).toBe(true);
    expect(status.stale).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).toBe("# Manual project brief\nKeep this edit.\n");
    expect(outputs).toHaveLength(1);
    store.close();
  });

  it("refuses a manual summary edit made between generation and the atomic commit", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    await refreshProjectSummary(store, config, { generator });
    writeFileSync(join(rootDir, "README.md"), "# Input changed during review\n");
    const manual = "# Concurrent manual edit\nDo not overwrite.\n";

    const result = await refreshProjectSummary(store, config, {
      generator: {
        async generate() {
          return "# Generated after concurrent edit\n";
        }
      },
      summaryBeforeCommit(destinationPath) {
        if (destinationPath === summaryPath) writeFileSync(summaryPath, manual);
      }
    });

    expect(result).toMatchObject({ generated: false, skippedReason: "manual_edits_detected", manualEditsDetected: true });
    expect(readFileSync(summaryPath, "utf8")).toBe(manual);
    store.close();
  });

  it("backs up manual summary bytes before a forced atomic replacement", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    await refreshProjectSummary(store, config, { generator });
    const manual = "# Manual project brief\nExact recovery bytes.\n";
    writeFileSync(summaryPath, manual);

    const result = await refreshProjectSummary(store, config, {
      generator,
      force: true,
      now: () => new Date("2026-06-18T12:34:56Z")
    });

    expect(result.generated).toBe(true);
    expect(result.backupPath).toBe(
      join(rootDir, ".code-butler", "backups", "project-summary", "project-summary-2026-06-18T12-34-56-000Z.md")
    );
    expect(readFileSync(result.backupPath!, "utf8")).toBe(manual);
    expect(readFileSync(summaryPath, "utf8")).not.toBe(manual);
    store.close();
  });

  it("retains the recovery backup and original summary when forced generation fails", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    await refreshProjectSummary(store, config, { generator });
    const manual = "# Manual summary before failed force\n";
    writeFileSync(summaryPath, manual);

    await expect(refreshProjectSummary(store, config, {
      force: true,
      now: () => new Date("2026-06-18T13:00:00Z"),
      generator: { async generate() { throw new Error("provider failed"); } }
    })).rejects.toThrow("provider failed");

    const backupPath = join(
      rootDir,
      ".code-butler",
      "backups",
      "project-summary",
      "project-summary-2026-06-18T13-00-00-000Z.md"
    );
    expect(readFileSync(summaryPath, "utf8")).toBe(manual);
    expect(readFileSync(backupPath, "utf8")).toBe(manual);
    store.close();
  });

  it.runIf(sep === "/")("ignores a symlinked notes overlay outside the project", () => {
    const { rootDir } = createProject();
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const outsideNotes = join(outsideDir, "notes.md");
    writeFileSync(outsideNotes, "external private notes\n");
    symlinkSync(outsideNotes, join(rootDir, ".code-butler", "project-summary-notes.md"));
    const store = openMemoryStore(rootDir);
    store.init();

    const input = collectProjectSummaryInput(store, loadProjectConfig(rootDir));

    expect(input.notes).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain("external private notes");
    store.close();
  });

  it("requires force when an existing summary has no trustworthy output baseline", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(summaryPath, "# Preexisting summary\n");

    const result = await refreshProjectSummary(store, config, { generator });

    expect(result.generated).toBe(false);
    expect(result.skippedReason).toBe("output_baseline_missing");
    expect(outputs).toHaveLength(0);
    expect(readFileSync(summaryPath, "utf8")).toBe("# Preexisting summary\n");
    store.close();
  });

  it("establishes a legacy output baseline only when the input fingerprint is still current", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    await refreshProjectSummary(store, config, { generator });
    const metaPath = join(rootDir, ".code-butler", "project-summary.meta.json");
    const legacyMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete legacyMeta.outputContentHash;
    writeFileSync(metaPath, JSON.stringify(legacyMeta));

    const result = await refreshProjectSummary(store, config, { generator });
    const repairedMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;

    expect(result.generated).toBe(false);
    expect(repairedMeta.outputContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outputs).toHaveLength(1);
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
    const { rootDir, generator, outputs, inputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    store.addCommit({
      hash: "agent-hints-commit",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-06-14T00:00:00Z",
      message: "Update agent instructions",
      changedFiles: ["AGENTS.md", "CLAUDE.md"],
      diffSummary: "+ update bootstrap guidance"
    });

    await installProjectSummary(store, config, { generator, now: () => new Date("2026-06-15T00:00:00Z") });
    const quiet = await refreshProjectSummaryIfDue(store, config, {
      generator,
      now: () => new Date("2026-06-16T00:00:00Z")
    });

    expect(quiet.generated).toBe(false);
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(inputs)).not.toContain("stale agent instructions");
    expect(JSON.stringify(collectProjectSummaryInput(store, config))).not.toContain("stale agent instructions");
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

  it("builds every file-derived generator field from validated tracked safe files", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "package.json"), JSON.stringify({ main: "src/index.ts" }));
    writeFileSync(join(rootDir, "README.md"), "# Safe tracked README\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "# Safe tracked agent hints\n");
    writeFileSync(join(rootDir, "src", "index.ts"), "export const entry = true;\n");
    writeFileSync(join(rootDir, "src", "memory.ts"), "export const memory = true;\n");
    writeFileSync(join(rootDir, "src", "recent.ts"), "export const recent = true;\n");
    writeFileSync(join(rootDir, "src", "linked.ts"), "export const replaced = true;\n");
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "--all"]);

    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const secret = "SUPER_SECRET_PAYLOAD";
    for (const fileName of ["README.md", "AGENTS.md", "package.json", "linked.ts"]) {
      writeFileSync(join(outsideDir, fileName), `${secret}:${fileName}\n`);
    }
    rmSync(join(rootDir, "README.md"));
    symlinkSync(join(outsideDir, "README.md"), join(rootDir, "README.md"));
    rmSync(join(rootDir, "AGENTS.md"));
    symlinkSync(join(outsideDir, "AGENTS.md"), join(rootDir, "AGENTS.md"));
    rmSync(join(rootDir, "package.json"));
    symlinkSync(join(outsideDir, "package.json"), join(rootDir, "package.json"));
    rmSync(join(rootDir, "src", "linked.ts"));
    symlinkSync(join(outsideDir, "linked.ts"), join(rootDir, "src", "linked.ts"));
    mkdirSync(join(rootDir, "docs"), { recursive: true });
    writeFileSync(join(rootDir, "docs", "README.md"), `${secret}:untracked-doc\n`);
    writeFileSync(join(rootDir, "Cargo.toml"), `${secret}:untracked-manifest\n`);
    writeFileSync(join(rootDir, "CLAUDE.md"), `${secret}:untracked-agent\n`);
    writeFileSync(join(rootDir, "src", "untracked.ts"), `${secret}:untracked-code\n`);

    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Use memory implementation",
      summary: "The memory implementation is current.",
      reason: "Integration fixture",
      confidence: 0.99,
      evidence: [],
      relatedFiles: ["src/memory.ts", "src/linked.ts", "src/untracked.ts"],
      dedupeKey: "summary-safe-input"
    });
    store.promoteMemoryCandidate(candidate.id);
    store.addCommit({
      hash: "recent123",
      authorName: "Test User",
      authorEmail: "test@example.com",
      authoredAt: "2026-07-15T12:00:00Z",
      message: "Change recent implementation",
      changedFiles: ["src/recent.ts", "src/untracked.ts"],
      diffSummary: "+ safe recent change"
    });

    let captured: ProjectSummaryGeneratorInput | undefined;
    await refreshProjectSummary(store, loadProjectConfig(rootDir), {
      force: true,
      generator: {
        async generate(input) {
          captured = input;
          return "# Safe summary\n";
        }
      }
    });

    expect(captured).toBeDefined();
    const payload = JSON.stringify(captured);
    expect(payload).not.toContain(secret);
    expect(captured?.agentHints).toEqual([]);
    expect(captured?.codeContext.manifests).toEqual([]);
    expect(captured?.codeContext.docs).toEqual([]);
    expect(captured?.codeContext.codeFiles.map((file) => file.path)).toEqual(["src/memory.ts", "src/recent.ts"]);
    expect(captured?.codeContext.inventory).toEqual(expect.arrayContaining(["src/memory.ts", "src/recent.ts"]));
    expect(captured?.codeContext.inventory).not.toEqual(
      expect.arrayContaining(["README.md", "AGENTS.md", "package.json", "src/linked.ts", "src/untracked.ts"])
    );
    store.close();
  });

  it("changes the summary fingerprint for tail-only code changes beyond the content cap", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    const largeSource = (tail: string) => `${"x".repeat(2 * 1024 * 1024 + 1)}${tail}`;
    writeFileSync(join(rootDir, "src", "large.ts"), largeSource("tail-one"));
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "src/large.ts"]);
    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    const candidate = store.upsertMemoryCandidate({
      type: "constraint",
      title: "Large implementation",
      summary: "The large implementation is selected.",
      reason: "Fingerprint fixture",
      confidence: 0.99,
      evidence: [],
      relatedFiles: ["src/large.ts"],
      dedupeKey: "summary-tail-hash"
    });
    store.promoteMemoryCandidate(candidate.id);
    const config = loadProjectConfig(rootDir);

    const before = collectProjectSummaryInput(store, config);
    writeFileSync(join(rootDir, "src", "large.ts"), largeSource("tail-two"));
    const after = collectProjectSummaryInput(store, config);

    expect(after.codeContext.codeFiles[0]?.content).toBe(before.codeContext.codeFiles[0]?.content);
    expect(after.codeContext.codeFiles[0]?.contentHash).not.toBe(before.codeContext.codeFiles[0]?.contentHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    store.close();
  });

  it("discovers bounded nested workspace manifests and their entrypoints", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "packages", "app", "src"), { recursive: true });
    mkdirSync(join(rootDir, "crates", "worker", "src"), { recursive: true });
    writeFileSync(join(rootDir, "packages", "app", "package.json"), JSON.stringify({ main: "src/index.ts" }));
    writeFileSync(join(rootDir, "packages", "app", "src", "index.ts"), "export const app = true;\n");
    writeFileSync(join(rootDir, "crates", "worker", "Cargo.toml"), "[package]\nname = 'worker'\n");
    writeFileSync(join(rootDir, "crates", "worker", "src", "lib.rs"), "pub fn work() {}\n");
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "--all"]);
    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const input = collectProjectSummaryInput(store, loadProjectConfig(rootDir));

    expect(input.codeContext.manifests.map((file) => file.path)).toEqual([
      "crates/worker/Cargo.toml",
      "packages/app/package.json"
    ]);
    expect(input.codeContext.codeFiles.map((file) => file.path)).toEqual([
      "crates/worker/src/lib.rs",
      "packages/app/src/index.ts"
    ]);
    store.close();
  });

  it("filters unsafe nested manifests before applying the manifest count limit", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "workspace", "src"), { recursive: true });
    writeFileSync(join(rootDir, "package.json"), JSON.stringify({ main: "src/root.ts" }));
    writeFileSync(join(rootDir, "tsconfig.json"), "{}\n");
    writeFileSync(join(rootDir, "src", "root.ts"), "export const root = true;\n");
    writeFileSync(join(rootDir, "workspace", "package.json"), JSON.stringify({ main: "src/member.ts" }));
    writeFileSync(join(rootDir, "workspace", "src", "member.ts"), "export const member = true;\n");
    for (let index = 0; index < 101; index += 1) {
      const dir = join(rootDir, "secrets", String(index).padStart(3, "0"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}\n");
    }
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "--all"]);
    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const input = collectProjectSummaryInput(store, loadProjectConfig(rootDir));

    expect(input.codeContext.manifests.map((file) => file.path)).toEqual([
      "package.json",
      "tsconfig.json",
      "workspace/package.json"
    ]);
    expect(input.codeContext.codeFiles.map((file) => file.path)).toEqual([
      "src/root.ts",
      "workspace/src/member.ts"
    ]);
    store.close();
  });

  it("prioritizes root manifests and bounds manifest content while hashing full bytes", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "src"), { recursive: true });
    const rootManifest = (tail: string) => JSON.stringify({
      padding: `${"x".repeat(21_000)}${tail}`,
      main: "src/root.ts"
    });
    writeFileSync(join(rootDir, "package.json"), rootManifest("tail-one"));
    writeFileSync(join(rootDir, "tsconfig.json"), "{}\n");
    writeFileSync(join(rootDir, "src", "root.ts"), "export const root = true;\n");
    for (let index = 0; index < 10; index += 1) {
      const dir = join(rootDir, "z-modules", String(index).padStart(2, "0"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ padding: "y".repeat(20_000) }));
    }
    git(rootDir, ["init", "-q"]);
    git(rootDir, ["add", "--all"]);
    ensureProjectConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();

    const before = collectProjectSummaryInput(store, loadProjectConfig(rootDir));
    writeFileSync(join(rootDir, "package.json"), rootManifest("tail-two"));
    const after = collectProjectSummaryInput(store, loadProjectConfig(rootDir));

    expect(before.codeContext.manifests.slice(0, 2).map((file) => file.path)).toEqual([
      "package.json",
      "tsconfig.json"
    ]);
    expect(before.codeContext.manifests.every((file) => file.content.length <= 20_000)).toBe(true);
    expect(before.codeContext.manifests.reduce((sum, file) => sum + file.content.length, 0)).toBeLessThanOrEqual(120_000);
    expect(before.codeContext.codeFiles.map((file) => file.path)).toContain("src/root.ts");
    expect(after.codeContext.manifests[0]?.content).toBe(before.codeContext.manifests[0]?.content);
    expect(after.codeContext.manifests[0]?.contentHash).not.toBe(before.codeContext.manifests[0]?.contentHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    store.close();
  });
});
