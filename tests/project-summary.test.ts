// Tests summary generation, refresh ownership, and safe repository context.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { assembleHumanSummary } from "../src/project-summary/memory-sections.js";
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
import { importNewGitCommits, syncProjectMemory } from "../src/sync/service.js";
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
          "## What this is",
          "",
          "A repository summary.",
          "Purpose: Generated from verified code context.",
          "## How it's built", "Built from recorded repository facts."
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
    expect(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8")).toContain("# Project summary");
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

  it("runs the summary model call through aroundModelCall", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const wrapped: number[] = [];
    const result = await refreshProjectSummary(store, config, {
      generator,
      now: () => new Date("2026-06-16T00:00:00Z"),
      aroundModelCall: async call => { wrapped.push(outputs.length); const value = await call(); wrapped.push(outputs.length); return value; }
    });
    expect(result.generated).toBe(true);
    // The generator ran inside the wrapper: no output before it, one after.
    expect(wrapped).toEqual([0, 1]);
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

  it("adopts an edited summary as the baseline, dated when noticed, and keeps it protected", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    const metaPath = join(rootDir, ".code-butler", "project-summary.meta.json");
    await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-18T09:00:00Z") });
    const manual = "# Manual project brief\nKeep this edit.\n";
    writeFileSync(summaryPath, manual);

    const result = await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-18T10:00:00Z") });
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    const status = getProjectSummaryStatus(rootDir, { store, config });

    expect(result).toMatchObject({ generated: false, skippedReason: "manual_edits_detected", manualEditsDetected: true });
    expect(meta).toMatchObject({
      outputContentHash: createHash("sha256").update(manual).digest("hex"),
      contentSource: "edited",
      contentUpdatedAt: "2026-06-18T10:00:00.000Z",
      lastGeneratedAt: "2026-06-18T09:00:00.000Z"
    });
    expect(status).toMatchObject({ manualEditsDetected: true, stale: true, contentSource: "edited", contentUpdatedAt: "2026-06-18T10:00:00.000Z" });
    expect(readFileSync(summaryPath, "utf8")).toBe(manual);

    await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-19T10:00:00Z") });
    expect(JSON.parse(readFileSync(metaPath, "utf8"))).toMatchObject({ contentUpdatedAt: "2026-06-18T10:00:00.000Z" });
    expect(outputs).toHaveLength(1);

    const forced = await refreshProjectSummary(store, config, { generator, force: true, now: () => new Date("2026-06-19T11:00:00Z") });
    expect(forced.generated).toBe(true);
    expect(readFileSync(forced.backupPath!, "utf8")).toBe(manual);
    expect(JSON.parse(readFileSync(metaPath, "utf8"))).not.toHaveProperty("contentSource");
    store.close();
  });

  it("dates a committed summary by its git commit and replaces it automatically with a backup", async () => {
    const { rootDir, generator, outputs } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    const summaryPath = join(rootDir, ".code-butler", "project-summary.md");
    const committed = "# Committed summary\n";
    writeFileSync(summaryPath, committed);
    git(rootDir, ["add", "--all"]);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "summary", "--date=2026-05-01T08:00:00Z"], {
      cwd: rootDir, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-01T08:00:00Z" }
    });

    await expect(refreshProjectSummary(store, config, {
      generator: { async generate() { throw new Error("provider unavailable"); } }
    })).rejects.toThrow("provider unavailable");
    const adopted = getProjectSummaryStatus(rootDir, { store, config });
    expect(adopted).toMatchObject({
      outputBaselineMissing: false,
      manualEditsDetected: false,
      stale: true,
      contentSource: "git",
      contentUpdatedAt: "2026-05-01T08:00:00.000Z",
      contentCommit: git(rootDir, ["log", "-1", "--format=%h"])
    });
    expect(readFileSync(summaryPath, "utf8")).toBe(committed);

    const result = await refreshProjectSummary(store, config, { generator });
    expect(result.generated).toBe(true);
    expect(readFileSync(result.backupPath!, "utf8")).toBe(committed);
    expect(outputs).toHaveLength(1);
    expect(getProjectSummaryStatus(rootDir, { store, config })).not.toHaveProperty("contentSource");
    store.close();
  });

  it("stays current when the only new commit records the summary itself", async () => {
    const { rootDir, generator } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    await refreshProjectSummary(store, config, { generator });
    const commit = (hash: string, changedFiles: string[]) => store.addCommit({
      hash, authorName: "Test", authorEmail: "test@example.com", authoredAt: new Date().toISOString(),
      message: `commit ${hash}`, changedFiles, diffSummary: ""
    });

    commit("a".repeat(40), [".code-butler/project-summary.md", ".code-butler/project-summary.meta.json"]);
    expect(getProjectSummaryStatus(rootDir, { store, config }).stale).toBe(false);

    commit("b".repeat(40), [".code-butler/project-summary.md", "src/lib.rs"]);
    expect(getProjectSummaryStatus(rootDir, { store, config }).stale).toBe(true);
    store.close();
  });

  it("imports a commit made just before a manual refresh so the summary includes it", async () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    const config = loadProjectConfig(rootDir);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "Add encryption entry point"], { cwd: rootDir });
    const hash = git(rootDir, ["rev-parse", "HEAD"]);
    expect(collectProjectSummaryInput(store, config).codeContext.commits.map(c => c.hash)).not.toContain(hash);

    expect(importNewGitCommits(store, config)).toBe(1);
    expect(collectProjectSummaryInput(store, config).codeContext.commits.map(c => c.hash)).toContain(hash);
    expect(importNewGitCommits(store, config)).toBe(0);
    store.close();
  });

  it("records the generation time when the summary is written, not when the refresh starts", async () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    let clock = new Date("2026-06-18T09:00:00Z");
    const result = await refreshProjectSummary(store, loadProjectConfig(rootDir), {
      now: () => clock,
      generator: { async generate() { clock = new Date("2026-06-18T09:02:30Z"); return "## What this is\nA slow summary."; } }
    });

    expect(result.meta).toMatchObject({ lastGeneratedAt: "2026-06-18T09:02:30.000Z", lastCheckedAt: "2026-06-18T09:02:30.000Z" });
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

  describe("memory-only changes", () => {
    const generatedAt = new Date("2026-06-15T00:00:00Z");
    const at = (days: number) => () => new Date(generatedAt.getTime() + days * 24 * 60 * 60 * 1000);
    const prose = (summary: string) => [summary.split("## Key decisions")[0], summary.split("## Open risks and questions")[1]];

    async function generatedProject() {
      const project = createProject();
      const store = openMemoryStore(project.rootDir);
      store.init();
      const config = loadProjectConfig(project.rootDir);
      const kept = rememberProjectMemory(store, { type: "decision", text: "Use local project storage.", scope: { kind: "project" } }).memory!;
      await refreshProjectSummary(store, config, { generator: project.generator, now: at(0) });
      return { ...project, store, config, kept, before: readProjectBrief(project.rootDir) };
    }

    it("re-renders the memory sections and keeps the generated prose", async () => {
      const { rootDir, generator, outputs, store, config, kept, before } = await generatedProject();
      try {
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const added = await refreshProjectSummary(store, config, { generator, now: at(1) });
        const after = readProjectBrief(rootDir);

        expect(added).toMatchObject({ checked: true, generated: true, memorySectionsOnly: true });
        expect(outputs).toHaveLength(1);
        expect(after.summary).toContain("Ship releases from the default branch.");
        expect(prose(after.summary)).toEqual(prose(before.summary));
        expect(after.meta?.lastGeneratedAt).toBe(before.meta?.lastGeneratedAt);
        expect(after.meta?.basis).toEqual(before.meta?.basis);
        expect(after.meta?.memorySectionsUpdatedAt).toBe("2026-06-16T00:00:00.000Z");
        expect(getProjectSummaryStatus(rootDir, { store, config }).stale).toBe(false);

        store.updateMemoryLifecycle(kept.id, { lifecycleStatus: "superseded" });
        const removed = await refreshProjectSummaryIfDue(store, config, { generator, now: at(2) });
        expect(removed.memorySectionsOnly).toBe(true);
        expect(outputs).toHaveLength(1);
        expect(readProjectBrief(rootDir).summary).not.toContain("Use local project storage.");
      } finally { store.close(); }
    });

    it("reproduces an unchanged summary byte for byte", async () => {
      const { rootDir, store, config, before } = await generatedProject();
      try {
        const memories = collectProjectSummaryInput(store, config).codeContext.memories;
        expect(`${assembleHumanSummary(memories, before.summary).trim()}\n`).toBe(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8"));
      } finally { store.close(); }
    });

    it("rewrites the prose once it is a week old", async () => {
      const { generator, outputs, store, config } = await generatedProject();
      try {
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const result = await refreshProjectSummary(store, config, { generator, now: at(7) });
        expect(result.generated).toBe(true);
        expect(result.memorySectionsOnly).toBeUndefined();
        expect(outputs).toHaveLength(2);
      } finally { store.close(); }
    });

    it("rewrites the prose when forced", async () => {
      const { generator, outputs, store, config } = await generatedProject();
      try {
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const result = await refreshProjectSummary(store, config, { generator, now: at(1), force: true });
        expect(result.memorySectionsOnly).toBeUndefined();
        expect(outputs).toHaveLength(2);
      } finally { store.close(); }
    });

    it("rewrites the prose when the metadata cannot show what changed", async () => {
      const { rootDir, generator, outputs, store, config } = await generatedProject();
      try {
        const metaPath = join(rootDir, ".code-butler", "project-summary.meta.json");
        const { inputDigest: _digest, ...meta } = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const result = await refreshProjectSummary(store, config, { generator, now: at(1) });
        expect(result.memorySectionsOnly).toBeUndefined();
        expect(outputs).toHaveLength(2);
      } finally { store.close(); }
    });

    it("leaves an edited summary alone", async () => {
      const { rootDir, generator, outputs, store, config, before } = await generatedProject();
      try {
        const edited = `${before.summary.trim()}\n\nA note added by hand.\n`;
        writeFileSync(before.summaryPath, edited);
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const result = await refreshProjectSummary(store, config, { generator, now: at(1) });
        expect(result).toMatchObject({ generated: false, skippedReason: "manual_edits_detected" });
        expect(outputs).toHaveLength(1);
        expect(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8")).toBe(edited);
      } finally { store.close(); }
    });

    it("keeps an edit made while the memory sections are written", async () => {
      const { generator, store, config, before } = await generatedProject();
      try {
        const manual = "# Edited during the update\n";
        rememberProjectMemory(store, { type: "decision", text: "Ship releases from the default branch.", scope: { kind: "project" } });
        const result = await refreshProjectSummary(store, config, {
          generator,
          now: at(1),
          summaryBeforeCommit(destinationPath) {
            if (destinationPath === before.summaryPath) writeFileSync(before.summaryPath, manual);
          }
        });
        expect(result).toMatchObject({ generated: false, skippedReason: "manual_edits_detected", manualEditsDetected: true });
        expect(readFileSync(before.summaryPath, "utf8")).toBe(manual);
      } finally { store.close(); }
    });
  });

  it("does not regenerate the next day after a sync with no new evidence", async () => {
    const { rootDir, generator, outputs } = createProject();
    git(rootDir, ["-c", "user.name=Summary Test", "-c", "user.email=summary@example.test", "commit", "-qm", "Initial project"]);
    const store = openMemoryStore(rootDir);
    store.init();
    try {
      const config = loadProjectConfig(rootDir);
      const syncOptions = { source: "git" as const, extractorProvider: { async extract() { return { memories: [], rejected: [] }; } } };
      const initial = await syncProjectMemory(store, config, syncOptions);
      expect(initial.sources.git.error).toBeUndefined();
      expect(initial.sources.git.imported).toBe(1);
      store.recordSyncStatus({ source: "git", enabled: true, lastSyncAt: "2026-06-15T00:00:00Z", lastSuccessAt: "2026-06-15T00:00:00Z", metadata: { imported: 1 } });
      await refreshProjectSummary(store, config, { generator, now: () => new Date("2026-06-15T00:00:00Z") });
      const before = readProjectBrief(rootDir);
      const beforeInput = collectProjectSummaryInput(store, config);
      const summaryMtime = statSync(before.summaryPath).mtimeMs;

      const empty = await syncProjectMemory(store, config, syncOptions);
      expect(empty.sources.git.error).toBeUndefined();
      expect(empty.sources.git.imported).toBe(0);
      const afterInput = collectProjectSummaryInput(store, config);
      expect(afterInput.codeContext.projectState).not.toEqual(beforeInput.codeContext.projectState);
      const quiet = await refreshProjectSummaryIfDue(store, config, { generator, now: () => new Date("2026-06-16T00:00:00Z") });
      expect(quiet.generated).toBe(false);
      expect(outputs).toHaveLength(1);
      expect(afterInput.fingerprint).toBe(beforeInput.fingerprint);
      expect(readProjectBrief(rootDir).summary).toBe(before.summary);
      expect(statSync(before.summaryPath).mtimeMs).toBe(summaryMtime);
      expect(readProjectBrief(rootDir).meta?.lastCheckedAt).toBe("2026-06-16T00:00:00.000Z");

      // A real commit must still invalidate the fingerprint on the next check.
      writeFileSync(join(rootDir, "README.md"), "# Example Project\nNew project behavior.\n");
      git(rootDir, ["add", "README.md"]);
      git(rootDir, ["-c", "user.name=Summary Test", "-c", "user.email=summary@example.test", "commit", "-qm", "Document new behavior"]);
      const changedSync = await syncProjectMemory(store, config, syncOptions);
      expect(changedSync.sources.git.imported).toBe(1);
      const changed = await refreshProjectSummaryIfDue(store, config, { generator, now: () => new Date("2026-06-17T00:00:00Z") });
      expect(changed.generated).toBe(true);
      expect(outputs).toHaveLength(2);
    } finally { store.close(); }
  }, 120_000);

  it("ignores transient sync failures and recovery when fingerprinting summary content", () => {
    const { rootDir } = createProject();
    const store = openMemoryStore(rootDir);
    store.init();
    try {
      const config = loadProjectConfig(rootDir);
      const before = collectProjectSummaryInput(store, config).fingerprint;
      store.recordSyncStatus({ source: "git", enabled: true, lastSyncAt: "2026-06-15T00:00:00Z", lastError: "Git unavailable" });
      const failed = collectProjectSummaryInput(store, config);
      expect(failed.codeContext.projectState.syncSources.git?.lastError).toBe("Git unavailable");
      expect(failed.fingerprint).toBe(before);
      store.recordSyncStatus({ source: "git", enabled: true, lastSyncAt: "2026-06-16T00:00:00Z", lastSuccessAt: "2026-06-16T00:00:00Z", metadata: { imported: 0 } });
      expect(collectProjectSummaryInput(store, config).fingerprint).toBe(before);
    } finally { store.close(); }
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

  it.runIf(sep === "/")("builds every file-derived generator field from validated tracked safe files", async () => {
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
