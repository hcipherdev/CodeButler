import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isCliEntrypoint, runCli } from "../src/cli.js";
import { loadProjectConfig } from "../src/config.js";
import type { ProjectSummaryGenerator } from "../src/project-summary/service.js";
import { openMemoryStore } from "../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("CLI", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
    delete process.env.TEST_CODE_BUTLER_API_KEY;
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

  it("initializes local storage and imports a conversation", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const output: string[] = [];
    const conversation = join(rootDir, "session.md");
    writeFileSync(conversation, "We changed src/cache.ts to prevent stale reads.");

    await expect(runCli(["init"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(0);
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
    tempDirs.push(rootDir);
    writeFileSync(join(rootDir, "README.md"), "# Auto Summary Project\n");
    writeFileSync(join(rootDir, "AGENTS.md"), "old agents");
    writeFileSync(join(rootDir, "CLAUDE.md"), "old claude");
    const output: string[] = [];

    await expect(
      runCli(["init"], {
        cwd: rootDir,
        stdout: (line) => output.push(line),
        now: () => new Date("2026-06-16T10:00:00Z")
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
    expect(readFileSync(join(rootDir, "AGENTS.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toBe("old agents");
    expect(readFileSync(join(rootDir, "CLAUDE.md.code-butler-backup-2026-06-16T10-00-00-000Z"), "utf8")).toBe("old claude");
    expect(output.join("\n")).toContain("fallback summary was created");
    expect(output.join("\n")).toContain("code-butler project-summary refresh --force");
  });

  it("initializes config and syncs configured sources", async () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const output: string[] = [];
    const repoDir = join(rootDir, "repo");
    const codexDir = join(rootDir, "codex");
    const claudeDir = join(rootDir, "claude");
    writeFileSync(join(rootDir, "placeholder.txt"), "");

    await expect(runCli(["init"], { cwd: rootDir, stdout: (line) => output.push(line) })).resolves.toBe(0);

    const config = loadProjectConfig(rootDir);
    expect(existsSync(config.configPath)).toBe(true);
    expect(output.join("\n")).toContain("Initialized project memory");

    expect(repoDir).toBeTruthy();
    expect(codexDir).toBeTruthy();
    expect(claudeDir).toBeTruthy();
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
      evidence: [{ sourceType: "conversation", sourceId: "conv-1" }],
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
      evidence: [{ sourceType: "conversation", sourceId: "conv-1" }],
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
