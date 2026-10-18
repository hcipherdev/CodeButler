import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerWatchedProject, listWatchedProjects, globalWatchStatus, runGlobalWatch, unregisterWatchedProject, requestGlobalWatchStop, recordCloudRunSuccess } from "../src/global-watch.js";
import { requestAutomaticSync } from "../src/cloud/sync-owner.js";
import { saveBinding } from "../src/cloud/state.js";
import { gitExecutable } from "../src/git-executable.js";
import { getWatchServiceStatus, installWatchService, uninstallWatchService } from "../src/watch-service.js";
import { runCli } from "../src/cli.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";
import { beginForegroundIntent } from "../src/cloud/foreground.js";
import { watcherOwnsProjectGate } from "../src/cloud/gate.js";

describe("global watcher", () => {
  let directory: string;
  beforeEach(() => {
    directory = makeTempDir();
    vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  });
  afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });
  function project(name: string): string {
    const root = join(directory, name);
    mkdirSync(join(root, ".code-butler"), { recursive: true });
    writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
      sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } }
    }));
    return root;
  }

  it("deduplicates registrations and keeps processing after a missing or failing project", async () => {
    const first = project("a");
    const second = project("b");
    registerWatchedProject(first);
    registerWatchedProject(join(first, "."));
    registerWatchedProject(second);
    expect(listWatchedProjects()).toHaveLength(2);
    const seen: string[] = [];
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async root => {
      expect(globalWatchStatus().running).toBe(true);
      seen.push(root);
      if (root === first) throw new Error("first project failed");
    } });
    expect(seen).toEqual([first, second]);
    const status = globalWatchStatus();
    expect(status.running).toBe(false);
    expect(status.projects.map(item => item.lastRun?.ok)).toEqual([false, true]);
    unregisterWatchedProject(first);
    expect(listWatchedProjects().map(item => item.root)).toEqual([second]);
  });

  it.runIf(process.platform === "win32")("starts after a legacy watch lock PID was reused", async () => {
    const watch = join(directory, "home", "watch");
    mkdirSync(join(watch, ".code-butler"), { recursive: true });
    const lock = join(watch, ".code-butler", ".cloud-operation.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "old-watcher", startedAt: "2020-01-01T00:00:00.000Z" }));
    await runGlobalWatch({ cliPath: "unused", once: true });
    expect(existsSync(lock)).toBe(false);
    expect(globalWatchStatus().running).toBe(false);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("reloads registered projects while running and shuts down cleanly", async () => {
    const first = project("a");
    const second = project("b");
    registerWatchedProject(first);
    const controller = new AbortController();
    // Stop the watcher however the test ends; a missed abort would otherwise keep it, and the run, alive.
    onTestFinished(() => controller.abort());
    const seen: string[] = [];
    await runGlobalWatch({ cliPath: "unused", intervalSeconds: 0.01, signal: controller.signal,
      runProject: async root => {
        seen.push(root);
        if (root === first) registerWatchedProject(second);
        if (root === second) controller.abort();
      }
    });
    expect(seen).toEqual([first, second]);
    expect(globalWatchStatus().running).toBe(false);
  });

  it("runs a bounded local watch pass without creating bootstrap documents", async () => {
    const root = project("one-shot");
    const output: string[] = [];
    expect(await runCli(["watch", "--once"], { cwd: root, stdout: line => output.push(line) })).toBe(0);
    expect(output.join("\n")).toContain("Synced project memory");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, ".code-butler", "project-summary.md"))).toBe(false);
  });

  it("runs a cloud-only child without entering ingestion or summary", () => {
    const root = project("cloud-only");
    const loader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;
    const output = execFileSync(process.execPath, ["--import", loader, join(process.cwd(), "src", "cli.ts"), "watch", "--once", "--cloud-only"], {
      cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, CODE_BUTLER_WATCH_TOKEN: "test-watcher-token", CODE_BUTLER_HOME: join(directory, "home") }
    });
    expect(output).not.toContain("Synced project memory");
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(false);
  });

  it("collects a real isolated worker's structured stage report over IPC", async () => {
    registerWatchedProject(project("worker-ipc"));
    await runGlobalWatch({ cliPath: join(process.cwd(), "tests", "fixtures", "watch-cli.mjs"), once: true });
    expect(globalWatchStatus().projects[0]!.lastRun).toMatchObject({ ok: true, outcome: "success", stages: { ingestion: { outcome: "success" } } });
  });

  it("cooperatively stops only its verified watcher child after the foreground wait limit", async () => {
    const root = project("foreground-stop");
    registerWatchedProject(root);
    const watch = runGlobalWatch({ cliPath: join(process.cwd(), "tests", "fixtures", "watch-hold.mjs"), once: true });
    const lock = join(root, ".code-butler", ".cloud-operation.lock");
    let intent: ReturnType<typeof beginForegroundIntent> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(lock)).toBe(true), { timeout: 20_000 });
      const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
      expect(watcherOwnsProjectGate(root, owner.pid, "different-pass")).toBe(false);
      intent = beginForegroundIntent(root);
      const path = join(root, ".code-butler", ".foreground-intents", `${intent.id}.json`);
      writeFileSync(path, JSON.stringify({ id: intent.id, requestedAt: Date.now() - 120_001, expiresAt: Date.now() + 45_000 }));
      await watch;
      expect(globalWatchStatus().projects[0]?.lastRun?.outcome).toBe("deferred");
    } finally { intent?.release(); requestGlobalWatchStop(); await watch; }
  });

  it("does not preempt a lock attributed to a manual process", async () => {
    const root = project("manual-lock");
    registerWatchedProject(root);
    vi.stubEnv("WATCH_FIXTURE_LOCK_PID", String(process.pid));
    const controller = new AbortController();
    const watch = runGlobalWatch({ cliPath: join(process.cwd(), "tests", "fixtures", "watch-hold.mjs"), once: true, signal: controller.signal });
    const lock = join(root, ".code-butler", ".cloud-operation.lock");
    let intent: ReturnType<typeof beginForegroundIntent> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(lock)).toBe(true), { timeout: 20_000 });
      intent = beginForegroundIntent(root);
      writeFileSync(join(root, ".code-butler", ".foreground-intents", `${intent.id}.json`),
        JSON.stringify({ id: intent.id, requestedAt: Date.now() - 120_001, expiresAt: Date.now() + 45_000 }));
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(existsSync(lock)).toBe(true);
    } finally { intent?.release(); controller.abort(); await watch; }
  });

  it("registers a project through a real MCP connection and retains it after disconnect", async () => {
    const root = project("mcp");
    const client = new Client({ name: "watch-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "mcp", "--project-root", root],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stderr: "pipe"
    });
    try {
      await client.connect(transport);
      await client.callTool({ name: "current_project", arguments: {} });
      expect(listWatchedProjects().map(item => item.root)).toContain(root);
    } finally { await client.close(); }
    expect(listWatchedProjects().map(item => item.root)).toContain(root);
  });

  it("does not overlap two global workers", async () => {
    const root = project("singleton");
    registerWatchedProject(root);
    let active = 0;
    let maximum = 0;
    const runProject = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 60));
      active--;
    };
    await Promise.all([
      runGlobalWatch({ cliPath: "unused", once: true, runProject }),
      runGlobalWatch({ cliPath: "unused", once: true, runProject })
    ]);
    expect(maximum).toBe(1);
  });

  it("reserves the second worker for cloud jobs across a large registration set", async () => {
    for (let index = 0; index < 30; index++) registerWatchedProject(project(`many-${String(index).padStart(2, "0")}`));
    const running = new Set<string>();
    let maximum = 0, overlap = false, completed = 0;
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async root => {
      if (running.has(root)) overlap = true;
      running.add(root); maximum = Math.max(maximum, running.size);
      await new Promise(resolve => setTimeout(resolve, 12));
      running.delete(root); completed++;
    } });
    expect(completed).toBe(30);
    expect(maximum).toBe(1);
    expect(overlap).toBe(false);
  });

  it("starts a queued cloud-only request before the remaining background projects", async () => {
    const roots = ["a", "b", "c", "d"].map(name => project(name));
    roots.forEach(registerWatchedProject);
    const target = roots[3]!;
    saveBinding(target, { server: "http://127.0.0.1", projectId: "test", vaultId: "test", enabled: true, revision: 0, fingerprint: "", status: "synced" });
    const started: Array<{ root: string; kind: string }> = [];
    requestAutomaticSync(target);
    const controller = new AbortController();
    const watch = runGlobalWatch({ cliPath: "unused", intervalSeconds: 60, signal: controller.signal, runProject: async (root, kind) => {
      started.push({ root, kind });
      if (root === target && kind === "cloud") controller.abort();
    } });
    await watch;
    expect(started[0]).toEqual({ root: target, kind: "cloud" });
    const status = globalWatchStatus().projects.find(project => project.root === target)!;
    expect(status.lastCloudRun?.outcome).toBe("success");
    expect(status.lastRun).toBeUndefined();
  });

  it("drops a cloud failure backoff once a resolve records success outside the watcher", async () => {
    const target = realpathSync(project("resolved")); registerWatchedProject(target);
    saveBinding(target, { server: "http://127.0.0.1", projectId: "test", vaultId: "test", enabled: true, revision: 0, fingerprint: "", status: "conflict" });
    requestAutomaticSync(target);
    const runs: number[] = [], controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 8000);
    await runGlobalWatch({ cliPath: "unused", intervalSeconds: 60, signal: controller.signal, runProject: async (root, kind) => {
      if (root !== target || kind !== "cloud") return;
      runs.push(Date.now());
      if (runs.length === 1) {
        // A failed cloud pass backs off at least ten seconds; the resolve lands meanwhile.
        setTimeout(() => recordCloudRunSuccess(target), 200);
        return { outcome: "failed", stage: "cloud", reason: "Cloud sync paused: conflicting snapshots." };
      }
      controller.abort();
    } });
    clearTimeout(guard);
    expect(runs).toHaveLength(2);
    expect(runs[1]! - runs[0]!).toBeLessThan(5000);
    expect(globalWatchStatus().projects.find(item => item.root === target)!.lastCloudRun).toMatchObject({ ok: true, outcome: "success" });
  }, 20000);

  it("keeps a background slot available when explicit requests remain queued", async () => {
    const roots = ["a", "b", "c"].map(name => project(name));
    for (const root of roots) {
      registerWatchedProject(root);
      saveBinding(root, { server: "http://127.0.0.1", projectId: "test", vaultId: "test", enabled: true, revision: 0, fingerprint: "", status: "synced" });
      requestAutomaticSync(root);
    }
    const controller = new AbortController();
    const kinds: string[] = [];
    await runGlobalWatch({ cliPath: "unused", intervalSeconds: 60, signal: controller.signal, runProject: async (_root, kind) => {
      kinds.push(kind);
      if (kinds.length === 2) controller.abort();
    } });
    expect(kinds).toEqual(["cloud", "full"]);
  });

  it("drains both active workers on shutdown without starting another project", async () => {
    const roots = ["a", "b", "c"].map(name => project(name));
    roots.forEach(registerWatchedProject);
    saveBinding(roots[0]!, { server: "http://127.0.0.1", projectId: "test", vaultId: "test", enabled: true, revision: 0, fingerprint: "", status: "synced" });
    requestAutomaticSync(roots[0]!);
    const controller = new AbortController();
    const started: string[] = [];
    const release: Array<() => void> = [];
    const watch = runGlobalWatch({ cliPath: "unused", intervalSeconds: 60, signal: controller.signal, runProject: async root => {
      started.push(root);
      await new Promise<void>(resolve => release.push(resolve));
    } });
    try { await vi.waitFor(() => expect(release).toHaveLength(2), { timeout: 20_000 }); }
    finally { controller.abort(); release.forEach(done => done()); await watch; }
    expect(started).toHaveLength(2);
    expect(globalWatchStatus().running).toBe(false);
  });

  it("reports source failure as a failed pass rather than a successful update", async () => {
    const root = project("bad-git");
    writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({
      sources: { git: { enabled: true }, codex: { enabled: false }, claude: { enabled: false } }
    }));
    expect(await runCli(["watch", "--once"], { cwd: root, stdout: () => {} })).toBe(1);
  });

  it("returns temporary exit 75 for a gate held over fifteen seconds, then recovers", async () => {
    const root = project("busy");
    const lock = join(root, ".code-butler", ".cloud-operation.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "test-held-operation" }));
    try { expect(await runCli(["watch", "--once"], { cwd: root, stdout: () => {} })).toBe(75); }
    finally { unlinkSync(lock); }
    expect(await runCli(["watch", "--once"], { cwd: root, stdout: () => {} })).toBe(0);
  }, 45000);

  it("retains the last success and ingestion result during a deferred cloud pass", async () => {
    registerWatchedProject(project("status"));
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async () => {} });
    const lastSuccess = globalWatchStatus().projects[0]!.lastRun!.lastSuccessAt;
    await runGlobalWatch({ cliPath: "unused", once: true, runProject: async () => ({ outcome: "deferred", stage: "cloud", reason: "busy", stages: { ingestion: { outcome: "success", stage: "ingestion" } } }) });
    expect(globalWatchStatus().projects[0]!.lastRun).toMatchObject({ outcome: "deferred", ok: false, lastSuccessAt: lastSuccess, stages: { ingestion: { outcome: "success" } } });
  }, 20000);

  it("installs one hidden global Windows service with a stable home and no project-specific command", () => {
    const commands: string[][] = [];
    const result = installWatchService({ cwd: project("a"), global: true, platform: "win32", homeDir: directory,
      cliPath: "C:\\Code Butler\\dist\\cli.js", nodePath: "C:\\Code Butler\\node.exe",
      commandRunner: (command, args) => { commands.push([command, ...args]); }
    });
    expect(result.taskName).toBe("CodeButler-watch-global");
    const create = commands.find(command => command.includes("/Create"))!;
    expect(create.join(" ")).toContain("-WindowStyle Hidden");
    const launcher = readFileSync(join(directory, "home", "watch", "code-butler-watch-global.ps1"), "utf8");
    expect(launcher).toContain("$env:CODE_BUTLER_HOME");
    expect(launcher).toContain("'watch' '--global'");
    expect(launcher).not.toContain(join(directory, "a"));
  });

  it("falls back to a hidden per-user Startup entry when Task Scheduler is denied", () => {
    const calls: string[] = [];
    const options = { cwd: project("fallback"), global: true, platform: "win32" as const, homeDir: directory,
      commandRunner: (command: string) => {
        calls.push(command);
        if (command === "schtasks.exe") throw new Error("Access denied");
      }
    };
    const result = installWatchService(options);
    expect(result.servicePath).toMatch(/Startup.*\.vbs$/);
    expect(readFileSync(result.servicePath!, "utf8")).toContain(", 0, False");
    expect(calls).toContain("wscript.exe");
    expect(getWatchServiceStatus(options).installed).toBe(true);
    uninstallWatchService(options);
    expect(existsSync(result.servicePath!)).toBe(false);
  });

  it("stops a global worker cooperatively without terminating unrelated processes", async () => {
    registerWatchedProject(project("stop"));
    await runGlobalWatch({ cliPath: "unused", intervalSeconds: 60, runProject: async () => requestGlobalWatchStop() });
    expect(globalWatchStatus().running).toBe(false);
  });
});

describe("Git discovery for background processes", () => {
  it("prefers PATH and supports a machine-specific override", () => {
    const onPath = join("custom", "git.exe");
    expect(gitExecutable({ Path: "custom", ProgramFiles: "programs" }, "win32", value => value === onPath)).toBe(onPath);
    expect(gitExecutable({ CODE_BUTLER_GIT: "explicit" }, "win32", () => false)).toBe("explicit");
    expect(gitExecutable({}, "linux", () => true)).toBe("git");
  });
  it.runIf(process.platform === "win32")("can invoke installed Git with an empty inherited PATH", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    const executable = gitExecutable(env);
    expect(executable).not.toBe("git");
    expect(execFileSync(executable, ["--version"], { env, encoding: "utf8" })).toContain("git version");
  });
});
