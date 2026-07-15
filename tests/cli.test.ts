import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isCliEntrypoint, runCli } from "../src/cli.js";
import { loadProjectConfig } from "../src/config.js";
import { createEmbeddingEndpointHash, createProviderFingerprint, createProviderKey } from "../src/embeddings/fingerprint.js";
import type { ProjectSummaryGenerator } from "../src/project-summary/service.js";
import type { EmbeddingProvider } from "../src/types.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("CLI", () => {
  let tempDirs: string[] = [];
  const originalCodeButlerHome = process.env.CODE_BUTLER_HOME;

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
    delete process.env.TEST_CODE_BUTLER_API_KEY;
    if (originalCodeButlerHome === undefined) {
      delete process.env.CODE_BUTLER_HOME;
    } else {
      process.env.CODE_BUTLER_HOME = originalCodeButlerHome;
    }
  });

  it("recognizes symlinked bin paths as the CLI entrypoint", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const realCli = join(rootDir, "dist", "cli.js");
    const binCli = join(rootDir, "bin", "code-butler");
    mkdirSync(join(rootDir, "dist"), { recursive: true });
    mkdirSync(join(rootDir, "bin"), { recursive: true });
    writeFileSync(realCli, "#!/usr/bin/env node\n");
    symlinkSync(realCli, binCli);

    expect(isCliEntrypoint(pathToFileURL(realCli).href, binCli)).toBe(true);
  });

  it("hides watch install from help while keeping the compatibility command", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    const helpOutput: string[] = [];
    const installOutput: string[] = [];
    const { runner } = recordCommands();

    await expect(runCli(["help"], { cwd: rootDir, stdout: (line) => helpOutput.push(line) })).resolves.toBe(0);
    expect(helpOutput.join("\n")).not.toContain("watch install");

    await expect(
      runCli(["watch", "install"], {
        cwd: rootDir,
        stdout: (line) => installOutput.push(line),
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner: runner
      })
    ).resolves.toBe(0);
    expect(installOutput.join("\n")).toContain("Installed Code Butler watch service");
  });

  function createConversationProject(): { rootDir: string; claudeDir: string } {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const claudeDir = join(rootDir, "claude", "projects", "-Users-spiel-Documents-cli-project");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(claudeDir, "session-1.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T10:00:00Z",
        sessionId: "cli-session-1",
        cwd: rootDir,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CLI status should see this project conversation." }]
        }
      })
    );
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: false, roots: [], includeDefaultRoots: false },
            claude: { enabled: true, roots: ["./claude/projects"] }
          },
          extractor: {
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_API_KEY"
          }
        },
        null,
        2
      )
    );
    return { rootDir, claudeDir };
  }

  function writeDoctorConfig(rootDir: string): void {
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: false, roots: [], includeDefaultRoots: false, projectOnly: true },
            claude: { enabled: false, roots: [], projectOnly: true }
          },
          extractor: {
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_CODE_BUTLER_API_KEY"
          },
          investigator: {
            enabled: true,
            mode: "native-rlm",
            provider: "openai-compatible",
            baseUrl: "https://example.test/v1",
            model: "gpt-test",
            apiKeyEnv: "TEST_CODE_BUTLER_API_KEY"
          }
        },
        null,
        2
      )
    );
  }

  function writeDoctorSummary(rootDir: string): void {
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Summary\n");
    writeFileSync(
      join(rootDir, ".code-butler", "project-summary.meta.json"),
      JSON.stringify({
        version: 1,
        summaryPath: join(rootDir, ".code-butler", "project-summary.md"),
        fingerprint: "test",
        lastGeneratedAt: "2026-06-24T10:00:00.000Z",
        lastCheckedAt: "2026-06-24T10:00:00.000Z"
      })
    );
  }

  const unavailableSummaryGenerator: ProjectSummaryGenerator = {
    name: "test-unavailable",
    async generate() {
      throw new Error("test summary provider unavailable");
    }
  };

  function recordCommands(): {
    commands: Array<{ command: string; args: string[] }>;
    runner: (command: string, args: string[]) => void;
  } {
    const commands: Array<{ command: string; args: string[] }> = [];
    return {
      commands,
      runner(command, args) {
        commands.push({ command, args });
      }
    };
  }

  it("initializes local storage and imports a conversation", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    const output: string[] = [];
    const conversation = join(rootDir, "session.md");
    writeFileSync(conversation, "We changed src/cache.ts to prevent stale reads.");

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner: recordCommands().runner
      })
    ).resolves.toBe(0);
    await expect(
      runCli(["ingest", "conversation", conversation], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    expect(existsSync(join(rootDir, ".code-butler", "memory.sqlite"))).toBe(true);
    const store = openMemoryStore(rootDir);
    store.init();
    expect(store.search({ query: "stale reads", limit: 5 })[0]?.title).toBe("session.md");
    store.close();
    expect(output.join("\n")).toContain("Imported conversation");
  });

  it("explicit init installs fallback project summary and agent bootstraps", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    writeFileSync(join(rootDir, "README.md"), "# Auto Summary Project\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "old agents");
    writeFileSync(join(rootDir, "CLAUDE.md"), "old claude");
    const output: string[] = [];
    const { runner } = recordCommands();

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        now: () => new Date("2026-06-16T10:00:00Z"),
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner: runner
      })
    ).resolves.toBe(0);

    expect(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8")).toContain(
      "Fallback Project Summary"
    );
    expect(JSON.parse(readFileSync(join(rootDir, ".code-butler", "project-summary.meta.json"), "utf8"))).toMatchObject({
      provider: "fallback"
    });
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("summarize_project_brief");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("sync_project_memory");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("tool discovery");
    expect(readFileSync(join(rootDir, "CLAUDE.md"), "utf8")).toContain("tool discovery");
    expect(readFileSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toBe("old agents");
    expect(readFileSync(join(rootDir, "CLAUDE.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toBe("old claude");
    expect(output.join("\n")).toContain("fallback summary was created");
    expect(output.join("\n")).toContain("code-butler project-summary refresh --force");
  });

  it("init installs and starts the macOS background watcher", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    writeFileSync(join(rootDir, "README.md"), "# Watch Project\n");
    const output: string[] = [];
    const { commands, runner } = recordCommands();

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner: runner,
        cliPath: "/opt/code-butler/dist/cli.js"
      })
    ).resolves.toBe(0);

    const launchAgentsDir = join(launchdHomeDir, "Library", "LaunchAgents");
    const plistFiles = readdirSync(launchAgentsDir).filter((name) => name.startsWith("com.codebutler.watch."));
    expect(plistFiles).toHaveLength(1);
    const plist = readFileSync(join(launchAgentsDir, plistFiles[0]!), "utf8");
    expect(plist).toContain("<string>watch</string>");
    expect(plist).toContain("<string>--interval</string>");
    expect(plist).toContain("<string>30</string>");
    expect(plist).toContain("<string>--source</string>");
    expect(plist).toContain("<string>all</string>");
    expect(plist).toContain("<string>/opt/code-butler/dist/cli.js</string>");
    expect(commands.some((item) => item.command === "launchctl" && item.args.includes("bootstrap"))).toBe(true);
    expect(output.join("\n")).toContain("Background watcher installed");
  });

  it("init installs and starts the Linux user systemd watcher", async () => {
    const rootDir = makeTempDir();
    const systemdHomeDir = makeTempDir();
    tempDirs.push(rootDir, systemdHomeDir);
    writeFileSync(join(rootDir, "README.md"), "# Linux Watch Project\n");
    const output: string[] = [];
    const { commands, runner } = recordCommands();

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: systemdHomeDir,
        watchServicePlatform: "linux",
        watchServiceCommandRunner: runner,
        cliPath: "/opt/code-butler/dist/cli.js"
      })
    ).resolves.toBe(0);

    const unitDir = join(systemdHomeDir, ".config", "systemd", "user");
    const unitFiles = readdirSync(unitDir).filter((name) => name.startsWith("code-butler-watch-"));
    expect(unitFiles).toHaveLength(1);
    const unit = readFileSync(join(unitDir, unitFiles[0]!), "utf8");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("/opt/code-butler/dist/cli.js watch --interval 30 --source all");
    expect(commands).toContainEqual({ command: "systemctl", args: ["--user", "daemon-reload"] });
    expect(commands).toContainEqual({ command: "systemctl", args: ["--user", "enable", "--now", unitFiles[0]!] });
    expect(output.join("\n")).toContain("Background watcher installed");
  });

  it("init creates and starts the Windows scheduled task watcher", async () => {
    const rootDir = makeTempDir();
    const homeDir = makeTempDir();
    tempDirs.push(rootDir, homeDir);
    writeFileSync(join(rootDir, "README.md"), "# Windows Watch Project\n");
    const output: string[] = [];
    const { commands, runner } = recordCommands();

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: homeDir,
        watchServicePlatform: "win32",
        watchServiceCommandRunner: runner,
        cliPath: "C:\\CodeButler\\dist\\cli.js"
      })
    ).resolves.toBe(0);

    const createCommand = commands.find((item) => item.command === "schtasks.exe" && item.args.includes("/Create"));
    const runCommand = commands.find((item) => item.command === "schtasks.exe" && item.args.includes("/Run"));
    expect(createCommand?.args).toEqual(expect.arrayContaining(["/SC", "ONLOGON", "/F"]));
    expect(createCommand?.args.join(" ")).toContain("C:\\CodeButler\\dist\\cli.js");
    expect(createCommand?.args.join(" ")).toContain("watch --interval 30 --source all");
    expect(runCommand?.args).toEqual(expect.arrayContaining(["/TN"]));
    expect(output.join("\n")).toContain("Background watcher installed");
  });

  it("init reports a clear error when background watcher installation fails", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    writeFileSync(join(rootDir, "README.md"), "# Failing Watch Project\n");
    const errors: string[] = [];

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stderr: (line) => errors.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner() {
          throw new Error("launchctl unavailable");
        }
      })
    ).resolves.toBe(1);

    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(true);
    expect(errors.join("\n")).toContain("Failed to install Code Butler background watcher");
    expect(errors.join("\n")).toContain("launchctl unavailable");
  });

  it("initializes config and syncs configured sources", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    const output: string[] = [];
    const repoDir = join(rootDir, "repo");
    const codexDir = join(rootDir, "codex");
    const claudeDir = join(rootDir, "claude");
    writeFileSync(join(rootDir, "placeholder.txt"), "");

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        projectSummaryGenerator: unavailableSummaryGenerator,
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceCommandRunner: recordCommands().runner
      })
    ).resolves.toBe(0);

    const config = loadProjectConfig(rootDir);
    expect(existsSync(config.configPath)).toBe(true);
    expect(output.join("\n")).toContain("Initialized project memory");

    expect(repoDir).toBeTruthy();
    expect(codexDir).toBeTruthy();
    expect(claudeDir).toBeTruthy();
  });

  it("initializes global config without writing secrets", async () => {
    const rootDir = makeTempDir();
    const globalHome = join(rootDir, "global-code-butler");
    tempDirs.push(rootDir);
    process.env.CODE_BUTLER_HOME = globalHome;
    const output: string[] = [];

    await expect(runCli(["config", "global", "init"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(0);

    expect(existsSync(join(globalHome, "config.json"))).toBe(true);
    expect(existsSync(join(globalHome, ".env.example"))).toBe(true);
    expect(existsSync(join(globalHome, ".gitignore"))).toBe(true);
    expect(readFileSync(join(globalHome, ".env.example"), "utf8")).toContain("OPENAI_API_KEY=");
    expect(readFileSync(join(globalHome, ".env.example"), "utf8")).not.toContain("sk-");
    expect(JSON.parse(readFileSync(join(globalHome, "config.json"), "utf8"))).toMatchObject({
      defaults: {
        extractorProfile: "cheap",
        investigatorProfile: "smart"
      },
      profiles: {
        cheap: {
          provider: "openai-compatible",
          apiKeyEnv: "OPENAI_API_KEY"
        },
        smart: {
          provider: "openai-compatible",
          apiKeyEnv: "OPENAI_API_KEY"
        }
      }
    });
    expect(output.join("\n")).toContain(`Initialized global config at ${join(globalHome, "config.json")}`);
  });

  it("sync does not bootstrap an uninitialized project", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: ".", hookInstall: false, maxCommits: 50, maxDiffChars: 12000 },
            codex: { enabled: false, roots: [], includeDefaultRoots: false },
            claude: { enabled: false, roots: [] }
          }
        },
        null,
        2
      )
    );
    const output: string[] = [];

    await expect(runCli(["sync"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(0);

    expect(output.join("\n")).toContain("Synced project memory");
    expect(existsSync(join(rootDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(rootDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
  });

  it("reports source status without writing sync cursors", async () => {
    const { rootDir } = createConversationProject();
    const output: string[] = [];
    const store = openMemoryStore(rootDir);
    store.init();
    const before = store.db.prepare("select count(*) as count from sync_cursors").get() as { count: number };
    store.close();

    await expect(
      runCli(["sources", "status"], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    const afterStore = openMemoryStore(rootDir);
    afterStore.init();
    const after = afterStore.db.prepare("select count(*) as count from sync_cursors").get() as { count: number };
    afterStore.close();
    const text = output.join("\n");
    expect(after.count).toBe(before.count);
    expect(text).toContain("Source Status");
    expect(text).toContain("claude");
    expect(text).toContain("found=1");
    expect(text).toContain("pending=1");
    expect(text).toContain("Conversations in SQLite: 0");
  });

  it("audits memory quality as JSON without mutating by default", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "session.md",
        origin: "manual-import",
        rawContent: "Use SQLite for local project memory."
      },
      chunks: [{ text: "Use SQLite for local project memory." }]
    });
    store.upsertMemoryCandidate({
      type: "constraint",
      title: "Bad HTML",
      summary: "</code></td><td>architecture.html</td>",
      reason: "Noisy import.",
      confidence: 0.9,
      evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" }],
      relatedFiles: [],
      dedupeKey: "bad-html"
    });
    store.close();

    const output: string[] = [];
    await expect(
      runCli(["memory", "audit", "--json"], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    const audit = JSON.parse(output.join("\n")) as {
      scanned: number;
      changes: Array<{ id: string; nextStatus: string; reasons: string[] }>;
      topReasons: Array<{ reason: string; count: number }>;
    };
    expect(audit.scanned).toBe(1);
    expect(audit.changes).toEqual([
      expect.objectContaining({
        nextStatus: "quarantined",
        reasons: expect.arrayContaining(["html_or_markup_content"])
      })
    ]);
    expect(audit.topReasons).toEqual([{ reason: "html_or_markup_content", count: 1 }]);

    const after = openMemoryStore(rootDir);
    after.init();
    expect(after.listMemoryCandidates({ qualityStatus: "all" })[0]?.qualityStatus).toBe("active");
    after.close();
  });

  it("remembers promoted project memory from the CLI", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const output: string[] = [];

    await expect(
      runCli(
        [
          "memory",
          "remember",
          "--type",
          "constraint",
          "--text",
          "Article templates must update datePublished before publishing.",
          "--title",
          "Article template dates",
          "--related-file",
          "main_web/article_update.sh"
        ],
        {
          cwd: rootDir,
          stdout: (line) => output.push(line),
          now: () => new Date("2026-07-09T20:00:00.000Z")
        }
      )
    ).resolves.toBe(0);

    expect(output.join("\n")).toContain("Remembered constraint memory");
    const store = openMemoryStore(rootDir);
    store.init();
    const memories = store.listMemories({ status: "promoted", query: "datePublished", limit: 5 });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      type: "constraint",
      title: "Article template dates",
      summary: "Article templates must update datePublished before publishing.",
      source: "manual",
      relatedFiles: ["main_web/article_update.sh"]
    });
    expect(store.readSource(memories[0]!.evidence[0]!.sourceId)?.rawContent).toContain("datePublished");
    store.close();
  });

  it("rejects incomplete memory remember CLI input", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(
      runCli(["memory", "remember", "--type", "constraint"], {
        cwd: rootDir,
        stderr: (line) => errors.push(line)
      })
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Usage: code-butler memory remember --type");
  });

  it("supersedes an existing memory from memory remember", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    await runCli(["memory", "remember", "--type", "decision", "--text", "Use cache policy A."], {
      cwd: rootDir,
      now: () => new Date("2026-07-12T13:00:00.000Z")
    });
    let store = openMemoryStore(rootDir);
    store.init();
    const original = store.listMemories({ lifecycleStatus: "current", qualityStatus: "all" })[0]!;
    store.close();

    const output: string[] = [];
    await expect(runCli([
      "memory", "remember",
      "--type", "decision",
      "--text", "Use cache policy B.",
      "--supersedes", original.id
    ], {
      cwd: rootDir,
      stdout: (line) => output.push(line),
      now: () => new Date("2026-07-12T13:05:00.000Z")
    })).resolves.toBe(0);

    store = openMemoryStore(rootDir);
    store.init();
    expect(store.readMemory(original.id)).toMatchObject({
      lifecycleStatus: "superseded",
      validUntil: "2026-07-12T13:05:00.000Z"
    });
    expect(store.listMemoryRelations({ relationType: "supersedes" })).toEqual([
      expect.objectContaining({ toMemoryId: original.id })
    ]);
    store.close();
    expect(output.join("\n")).toContain("Remembered decision memory");
  });

  it("rejects memory remember supersedes with candidate mode", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(runCli([
      "memory", "remember",
      "--type", "decision",
      "--text", "Candidate replacement.",
      "--candidate",
      "--supersedes", "memory-old"
    ], {
      cwd: rootDir,
      stderr: (line) => errors.push(line)
    })).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Superseding a durable memory requires promotion");
    expect(existsSync(join(rootDir, ".code-butler"))).toBe(false);
  });

  it("updates memory lifecycle status from the CLI with deterministic output", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    await runCli(["memory", "remember", "--type", "constraint", "--text", "Obsolete policy."], { cwd: rootDir });
    const store = openMemoryStore(rootDir);
    store.init();
    const memory = store.listMemories({ lifecycleStatus: "current", qualityStatus: "all" })[0]!;
    store.close();
    const output: string[] = [];

    await expect(runCli([
      "memory", "status",
      "--id", memory.id,
      "--status", "retracted",
      "--reason", "  The policy was incorrect.  "
    ], {
      cwd: rootDir,
      stdout: (line) => output.push(line),
      now: () => new Date("2026-07-12T14:00:00.000Z")
    })).resolves.toBe(0);

    expect(output).toEqual([`Memory ${memory.id} status=retracted replacement=none relations=0`]);
    const after = openMemoryStore(rootDir);
    after.init();
    expect(after.readMemory(memory.id)).toMatchObject({
      lifecycleStatus: "retracted",
      statusReason: "The policy was incorrect.",
      statusChangedAt: "2026-07-12T14:00:00.000Z"
    });
    after.close();
  });

  it("rejects invalid memory status combinations and missing or unknown flags", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const cases = [
      { args: ["memory", "status", "--id", "memory-1", "--status", "current", "--reason", "Restore.", "--replacement", "memory-2"], error: "--replacement is only allowed with superseded status" },
      { args: ["memory", "status", "--id", "memory-1", "--status", "superseded", "--reason", "Replaced."], error: "Superseded status requires --replacement" },
      { args: ["memory", "status", "--id", "memory-1", "--status", "archived", "--reason", "No."], error: "--status must be one of current, superseded, retracted" },
      { args: ["memory", "status", "--id", "memory-1", "--status", "retracted"], error: "Usage: code-butler memory status" },
      { args: ["memory", "status", "--bogus"], error: "Unknown memory status option: --bogus" }
    ];

    for (const testCase of cases) {
      const errors: string[] = [];
      await expect(runCli(testCase.args, { cwd: rootDir, stderr: (line) => errors.push(line) })).resolves.toBe(1);
      expect(errors.join("\n")).toContain(testCase.error);
    }
  });

  it("rejects whitespace-only lifecycle reasons without mutating memory", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    await runCli(["memory", "remember", "--type", "constraint", "--text", "Keep this policy."], { cwd: rootDir });
    const before = openMemoryStore(rootDir);
    before.init();
    const memory = before.listMemories({ lifecycleStatus: "current", qualityStatus: "all" })[0]!;
    before.close();
    const errors: string[] = [];

    await expect(runCli([
      "memory", "status",
      "--id", memory.id,
      "--status", "retracted",
      "--reason", "   "
    ], {
      cwd: rootDir,
      stderr: (line) => errors.push(line)
    })).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Lifecycle status reason is required");
    const after = openMemoryStore(rootDir);
    after.init();
    expect(after.readMemory(memory.id)).toMatchObject({ lifecycleStatus: "current" });
    after.close();
  });

  it("audits memory conflicts with dry-run, fix, JSON, and idempotent behavior", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    await runCli(["memory", "remember", "--type", "constraint", "--title", "Deploy port", "--text", "Use port 4100."], { cwd: rootDir });
    await runCli(["memory", "remember", "--type", "constraint", "--title", "Deploy port", "--text", "Use port 4200."], { cwd: rootDir });

    const dryRun: string[] = [];
    await expect(runCli(["memory", "conflicts"], {
      cwd: rootDir,
      stdout: (line) => dryRun.push(line)
    })).resolves.toBe(0);
    expect(dryRun).toEqual([
      "Memory Conflicts",
      "scanned=2 groups=1 conflicts=1 add=1 remove=0 change=2 applied=no"
    ]);
    let store = openMemoryStore(rootDir);
    store.init();
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toEqual([]);
    store.close();

    const fixed: string[] = [];
    await expect(runCli(["memory", "conflicts", "--fix"], {
      cwd: rootDir,
      stdout: (line) => fixed.push(line),
      now: () => new Date("2026-07-12T15:00:00.000Z")
    })).resolves.toBe(0);
    expect(fixed).toEqual([
      "Memory Conflicts",
      "scanned=2 groups=1 conflicts=1 add=1 remove=0 change=2 applied=yes"
    ]);

    const json: string[] = [];
    await expect(runCli(["memory", "conflicts", "--fix", "--json"], {
      cwd: rootDir,
      stdout: (line) => json.push(line),
      now: () => new Date("2026-07-12T15:01:00.000Z")
    })).resolves.toBe(0);
    expect(JSON.parse(json.join("\n"))).toMatchObject({
      scannedGroups: 1,
      scannedMemories: 2,
      conflictPairs: [expect.objectContaining({ fromMemoryId: expect.any(String), toMemoryId: expect.any(String) })],
      changes: [],
      complete: true
    });
    store = openMemoryStore(rootDir);
    store.init();
    expect(store.listMemoryRelations({ relationType: "potentially_contradicts" })).toHaveLength(1);
    store.close();
  });

  it("rejects unknown memory conflicts flags", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];
    await expect(runCli(["memory", "conflicts", "--bogus"], {
      cwd: rootDir,
      stderr: (line) => errors.push(line)
    })).resolves.toBe(1);
    expect(errors.join("\n")).toContain("Unknown memory conflicts option: --bogus");
  });

  it("fixes memory quality audit findings when requested", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({
      source: {
        id: "conv-1",
        type: "conversation",
        title: "session.md",
        origin: "manual-import",
        rawContent: "Use SQLite for local project memory."
      },
      chunks: [{ text: "Use SQLite for local project memory." }]
    });
    store.upsertMemoryCandidate({
      type: "constraint",
      title: "Bad HTML",
      summary: "</code></td><td>architecture.html</td>",
      reason: "Noisy import.",
      confidence: 0.9,
      evidence: [{ sourceType: "conversation", sourceId: "conv-1", locator: "conv-1:chunk:0" }],
      relatedFiles: [],
      dedupeKey: "bad-html"
    });
    store.close();

    const output: string[] = [];
    await expect(
      runCli(["memory", "audit", "--fix"], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    expect(output.join("\n")).toContain("Memory Audit");
    expect(output.join("\n")).toContain("updated=1");
    const after = openMemoryStore(rootDir);
    after.init();
    expect(after.listMemoryCandidates({ qualityStatus: "all" })[0]).toMatchObject({
      qualityStatus: "quarantined",
      qualityReasons: ["html_or_markup_content"]
    });
    after.close();
  });

  it("reports doctor status for a healthy initialized project", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeDoctorConfig(rootDir);
    writeDoctorSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const output: string[] = [];

    await expect(
      runCli(["doctor"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        now: () => new Date("2026-06-24T12:00:00.000Z")
      })
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(text).toContain("Code Butler Doctor");
    expect(text).toContain("Overall: ok");
    expect(text).toContain("[ok]");
  });

  it("prints doctor JSON reports", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    process.env.TEST_CODE_BUTLER_API_KEY = "test-key";
    writeDoctorConfig(rootDir);
    writeDoctorSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const output: string[] = [];

    await expect(
      runCli(["doctor", "--json"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        now: () => new Date("2026-06-24T12:00:00.000Z")
      })
    ).resolves.toBe(0);

    const report = JSON.parse(output.join("\n")) as { status: string; projectRoot: string; checks: unknown[] };
    expect(report.status).toBe("ok");
    expect(report.projectRoot).toBe(rootDir);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("exits nonzero on doctor errors without creating project state", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const output: string[] = [];

    await expect(
      runCli(["doctor"], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(1);

    expect(output.join("\n")).toContain("[error]");
    expect(existsSync(join(rootDir, ".code-butler", "config.json"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "memory.sqlite"))).toBe(false);
  });

  it("exits nonzero for doctor warnings in strict mode", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeDoctorConfig(rootDir);
    writeDoctorSummary(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const output: string[] = [];

    await expect(
      runCli(["doctor", "--strict"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        now: () => new Date("2026-06-24T12:00:00.000Z")
      })
    ).resolves.toBe(1);

    expect(output.join("\n")).toContain("Overall: warning");
    expect(output.join("\n")).toContain("[warn]");
  });

  it("prints stable embedding status in human and JSON formats", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeDoctorConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const human: string[] = [];
    const json: string[] = [];

    await expect(runCli(["embeddings", "status"], { cwd: rootDir, stdout: (line) => human.push(line) })).resolves.toBe(0);
    await expect(runCli(["embeddings", "status", "--json"], { cwd: rootDir, stdout: (line) => json.push(line) })).resolves.toBe(0);

    expect(human.join("\n")).toContain("Embedding Status");
    expect(human.join("\n")).toContain("provider=openai-compatible model=nomic-embed-text enabled=false");
    expect(human.join("\n")).toContain("eligible=0 coverage=0/0 pending=0 complete=0 failed=0 attempts=0");
    expect(JSON.parse(json.join("\n"))).toEqual(expect.objectContaining({ provider: "openai-compatible", model: "nomic-embed-text", enabled: false, eligible: 0, activeCoverage: 0, pending: 0, complete: 0, failed: 0 }));
  });

  it("rejects an explicit embedding build when embeddings are disabled", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeDoctorConfig(rootDir);
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const output: string[] = [];

    await expect(runCli(["embeddings", "build", "--json"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual(expect.objectContaining({ enabled: false, usable: false, activeCoverage: 0, built: 0, warnings: ["Embeddings are disabled"] }));
  });

  it("exits nonzero when an explicit remote embedding build is privacy-blocked", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeDoctorConfig(rootDir);
    const path = join(rootDir, ".code-butler", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.retrieval = { mode: "hybrid", rrfK: 60 };
    config.embeddings = { enabled: true, provider: "openai-compatible", baseUrl: "https://embedding.example/v1", model: "embed-test", batchSize: 16 };
    config.privacy = { allowRemoteEmbeddings: false };
    writeFileSync(path, JSON.stringify(config));
    const store = openMemoryStore(rootDir);
    store.init();
    store.close();
    const output: string[] = [];

    await expect(runCli(["embeddings", "build", "--json"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(1);
    expect(JSON.parse(output.join("\n")).warnings).toEqual(["Remote embeddings require privacy.allowRemoteEmbeddings=true"]);
  });

  it("uses structured build usability for repaired indexes and retryable provider failures", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    writeDoctorConfig(rootDir);
    const path = join(rootDir, ".code-butler", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.embeddings = { enabled: true, provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "embed-test", batchSize: 16 };
    writeFileSync(path, JSON.stringify(config));
    const endpointHash = createEmbeddingEndpointHash("http://127.0.0.1:11434/v1");
    const provider: EmbeddingProvider = {
      endpointHash,
      providerKey: createProviderKey(endpointHash, "embed-test"),
      isRemote: false,
      async embed() { throw new Error("retryable provider failure"); }
    };
    const store = openMemoryStore(rootDir);
    store.init();
    store.addSourceWithChunks({ source: { id: "mixed", type: "conversation", title: "mixed", origin: "test", rawContent: "one two" }, chunks: [{ text: "one" }, { text: "two" }] });
    for (const [index, owner] of store.listEmbeddingOwners().entries()) {
      const dimension = index + 2;
      store.upsertEmbeddingVector({ ...owner, providerKey: provider.providerKey, endpointHash, model: "embed-test", providerFingerprint: createProviderFingerprint(endpointHash, "embed-test", dimension), dimension, vectorBlob: new Uint8Array(dimension * 4) });
    }
    store.close();
    const mixedOutput: string[] = [];

    await expect(runCli(["embeddings", "build", "--json"], { cwd: rootDir, stdout: (line) => mixedOutput.push(line), embeddingServiceOptions: { provider } })).resolves.toBe(0);
    expect(JSON.parse(mixedOutput.join("\n"))).toMatchObject({ usable: true, failed: 2, activeCoverage: 0 });

    const cleanRoot = makeTempDir();
    tempDirs.push(cleanRoot);
    mkdirSync(join(cleanRoot, ".code-butler"), { recursive: true });
    writeFileSync(join(cleanRoot, ".code-butler", "config.json"), JSON.stringify(config));
    const cleanStore = openMemoryStore(cleanRoot);
    cleanStore.init();
    cleanStore.addSourceWithChunks({ source: { id: "retry", type: "conversation", title: "retry", origin: "test", rawContent: "retry" }, chunks: [{ text: "retry" }] });
    cleanStore.close();
    const retryOutput: string[] = [];
    await expect(runCli(["embeddings", "build", "--json"], { cwd: cleanRoot, stdout: (line) => retryOutput.push(line), embeddingServiceOptions: { provider } })).resolves.toBe(0);
    expect(JSON.parse(retryOutput.join("\n"))).toMatchObject({ usable: true, failed: 1, activeCoverage: 0 });
  });

  it("rejects unknown doctor flags", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(
      runCli(["doctor", "--bogus"], {
        cwd: rootDir,
        stderr: (line) => errors.push(line)
      })
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Unknown doctor option: --bogus");
    expect(errors.join("\n")).toContain("code-butler doctor [--json] [--strict]");
  });

  it("rejects invalid watch intervals", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(
      runCli(["watch", "--interval", "0"], {
        cwd: rootDir,
        stderr: (line) => errors.push(line)
      })
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("--interval must be a positive integer");
  });

  it("starts global mcp from the resolved git project root", async () => {
    const workspace = makeTempDir();
    tempDirs.push(workspace);
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const nested = join(workspace, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const errors: string[] = [];
    const starts: Array<{ rootDir?: string }> = [];

    await expect(
      runCli(["mcp"], {
        cwd: nested,
        env: {},
        stderr: (line) => errors.push(line),
        startServer: async (options) => {
          starts.push(options);
        }
      })
    ).resolves.toBe(0);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.rootDir).toBe(workspace);
    expect(existsSync(join(workspace, ".code-butler", "config.json"))).toBe(true);
    expect(existsSync(join(workspace, ".code-butler", "memory.sqlite"))).toBe(true);
    expect(existsSync(join(workspace, ".code-butler", ".gitignore"))).toBe(true);
    expect(errors.join("\n")).toContain("Starting Code Butler MCP for project");
  });

  it("keeps serve cwd scoped for backward compatibility", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const starts: Array<{ rootDir?: string }> = [];

    await expect(
      runCli(["serve"], {
        cwd: rootDir,
        startServer: async (options) => {
          starts.push(options);
        }
      })
    ).resolves.toBe(0);

    expect(starts).toEqual([{ rootDir }]);
  });

  it("requires --init-here for mcp outside a git repository", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(
      runCli(["mcp"], {
        cwd: rootDir,
        env: {},
        stderr: (line) => errors.push(line),
        startServer: async () => {}
      })
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("No Git repository found");
  });

  it("starts mcp from cwd outside a git repository with --init-here", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const starts: Array<{ rootDir?: string }> = [];
    const errors: string[] = [];

    await expect(
      runCli(["mcp", "--init-here"], {
        cwd: rootDir,
        env: {},
        stderr: (line) => errors.push(line),
        startServer: async (options) => {
          starts.push(options);
        }
      })
    ).resolves.toBe(0);

    expect(starts[0]?.rootDir).toBe(rootDir);
    expect(existsSync(join(rootDir, ".code-butler", "memory.sqlite"))).toBe(true);
    expect(errors.join("\n")).toContain("Starting Code Butler MCP for project");
  });

  it("runs watch immediately and again on the configured interval", async () => {
    vi.useFakeTimers();
    const { rootDir, claudeDir } = createConversationProject();
    const output: string[] = [];
    const controller = new AbortController();
    let summaryGenerations = 0;
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Existing Brief\n");
    writeFileSync(
      join(rootDir, ".code-butler", "project-summary.meta.json"),
      JSON.stringify({
        version: 1,
        summaryPath: join(rootDir, ".code-butler", "project-summary.md"),
        fingerprint: "old",
        lastGeneratedAt: "2026-06-14T10:00:00.000Z",
        lastCheckedAt: "2026-06-14T10:00:00.000Z"
      })
    );

    const watch = runCli(["watch", "--interval", "1", "--source", "claude"], {
      cwd: rootDir,
      stdout: (line) => output.push(line),
      signal: controller.signal,
      projectSummaryGenerator: {
        async generate() {
          summaryGenerations += 1;
          return "# Watch Generated Brief\n";
        }
      },
      now: () => new Date("2026-06-16T10:00:00Z")
    });

    await vi.waitFor(() => expect(output.filter((line) => line.includes("Synced project memory"))).toHaveLength(1));
    expect(readFileSync(join(rootDir, ".code-butler", "project-summary.md"), "utf8")).toContain(
      "Watch Generated Brief"
    );
    expect(summaryGenerations).toBe(1);
    writeFileSync(
      join(claudeDir, "session-1.jsonl"),
      readFileSync(join(claudeDir, "session-1.jsonl"), "utf8") +
        "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          sessionId: "cli-session-1",
          cwd: rootDir,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The watch loop should pick up this update." }]
          }
        })
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(output.filter((line) => line.includes("Synced project memory"))).toHaveLength(2));
    expect(summaryGenerations).toBe(1);
    controller.abort();

    await expect(watch).resolves.toBe(0);
  });

  it("watch does not bootstrap an uninitialized project", async () => {
    vi.useFakeTimers();
    const { rootDir } = createConversationProject();
    const output: string[] = [];
    const controller = new AbortController();
    let summaryGenerations = 0;

    const watch = runCli(["watch", "--interval", "1", "--source", "claude"], {
      cwd: rootDir,
      stdout: (line) => output.push(line),
      signal: controller.signal,
      projectSummaryGenerator: {
        async generate() {
          summaryGenerations += 1;
          return "# Watch Generated Brief\n";
        }
      },
      now: () => new Date("2026-06-16T10:00:00Z")
    });

    await vi.waitFor(() => expect(output.filter((line) => line.includes("Synced project memory"))).toHaveLength(1));
    expect(summaryGenerations).toBe(0);
    expect(existsSync(join(rootDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(rootDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(rootDir, ".code-butler", "project-summary.md"))).toBe(false);
    controller.abort();

    await expect(watch).resolves.toBe(0);
  });

  it("installs, reports, and uninstalls the macOS watch launch agent", async () => {
    const rootDir = makeTempDir();
    const launchdHomeDir = makeTempDir();
    tempDirs.push(rootDir, launchdHomeDir);
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", "config.json"),
      JSON.stringify(
        {
          sources: {
            git: { enabled: false, repoPath: "." },
            codex: { enabled: false, roots: [], includeDefaultRoots: false },
            claude: { enabled: false, roots: [] }
          }
        },
        null,
        2
      )
    );
    const output: string[] = [];

    await expect(
      runCli(["watch", "install", "--interval", "45", "--source", "git"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceLaunchctl: false
      })
    ).resolves.toBe(0);

    const launchAgentsDir = join(launchdHomeDir, "Library", "LaunchAgents");
    const plistFiles = readdirSync(launchAgentsDir).filter((name) => name.startsWith("com.codebutler.watch."));
    expect(plistFiles).toHaveLength(1);
    const plist = readFileSync(join(launchAgentsDir, plistFiles[0]!), "utf8");
    expect(plist).toContain("<string>watch</string>");
    expect(plist).toContain("<string>--interval</string>");
    expect(plist).toContain("<string>45</string>");
    expect(plist).toContain("<string>--source</string>");
    expect(plist).toContain("<string>git</string>");
    expect(plist).toContain(`<string>${rootDir}</string>`);

    const statusOutput: string[] = [];
    await expect(
      runCli(["watch", "status"], {
        cwd: rootDir,
        stdout: (line) => statusOutput.push(line),
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceLaunchctl: false
      })
    ).resolves.toBe(0);
    expect(statusOutput.join("\n")).toContain("installed=true");

    await expect(
      runCli(["watch", "uninstall"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        watchServiceHomeDir: launchdHomeDir,
        watchServicePlatform: "darwin",
        watchServiceLaunchctl: false
      })
    ).resolves.toBe(0);
    expect(existsSync(join(launchAgentsDir, plistFiles[0]!))).toBe(false);
  });

  it("rejects removed project summary install command", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const errors: string[] = [];

    await expect(
      runCli(["project-summary", "install"], {
        cwd: rootDir,
        stderr: (line) => errors.push(line)
      })
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("project-summary <refresh|status>");
  });

  it("reports project summary status", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", "project-summary.md"), "# Summary\n");
    writeFileSync(
      join(rootDir, ".code-butler", "project-summary.meta.json"),
      JSON.stringify({
        version: 1,
        summaryPath: join(rootDir, ".code-butler", "project-summary.md"),
        fingerprint: "abc",
        lastGeneratedAt: "2026-06-16T00:00:00.000Z",
        lastCheckedAt: "2026-06-16T00:00:00.000Z"
      })
    );
    const output: string[] = [];

    await expect(
      runCli(["project-summary", "status"], {
        cwd: rootDir,
        stdout: (line) => output.push(line)
      })
    ).resolves.toBe(0);

    expect(output.join("\n")).toContain("Project Summary Status");
    expect(output.join("\n")).toContain("exists=true");
    expect(output.join("\n")).toContain("fingerprint=abc");
    expect(output.join("\n")).toContain("currentFingerprint=");
  });
});
