// Tests Store launcher, MCP health, and Windows watcher handoff with disposable registrations.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableLauncher, aiClientStatus, checkedAiClientStatus, connectAiClient, type AiClientOptions } from "../../src/desktop/ai-clients.js";
import * as store from "../../src/store-runtime.js";
import { getWatchServiceStatus, installWatchService, uninstallWatchService } from "../../src/watch-service.js";
import * as watch from "../../src/global-watch.js";
import * as runtime from "../../src/runtime.js";
import { atomicJson, readJson } from "../../src/cloud/state.js";
import { runStoreWatcher } from "../../src/desktop/store-watcher.js";
import { isDesktopRuntimeInstallerEntrypoint } from "../../src/desktop/runtime-installer.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";

const alias = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\code-butler.exe";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Microsoft Store runtime", () => {
  it("recognizes the native alias even when Node cannot stat it", () => {
    expect(stableLauncher({ platform: "win32", env: { CODE_BUTLER_STORE_LAUNCHER: alias } }))
      .toEqual({ command: alias, args: ["mcp"] });
    const status = aiClientStatus({
      platform: "win32", home: "C:\\Users\\dev", env: { CODE_BUTLER_STORE_LAUNCHER: alias },
      exists: () => false, readText: () => undefined,
      run: () => ({ status: 1, stdout: "" })
    });
    expect(status.launcherInstalled).toBe(true);
    expect(status.clients[1]?.canConnect).toBe(true);
  });

  function codexMachine(command = alias) {
    const cli = "codex.exe";
    let entry = { enabled: true, transport: { type: "stdio", command, args: ["mcp"], env: { CODE_BUTLER_HOME: "D:\\Butler" } } };
    const run = vi.fn<NonNullable<AiClientOptions["run"]>>((executable, args) => {
      if (executable !== cli) return { status: 1, stdout: "" };
      if (args[0] === "--version") return { status: 0, stdout: "codex 1" };
      if (args[1] === "get") return { status: 0, stdout: JSON.stringify(entry) };
      if (args[1] === "add") {
        const target = args.slice(args.indexOf("--") + 1);
        entry = { ...entry, transport: { ...entry.transport, command: target[0]!, args: target.slice(1) } };
      }
      return { status: 0, stdout: "" };
    });
    const options: AiClientOptions = {
      platform: "win32", home: "C:\\Users\\dev",
      env: { CODE_BUTLER_STORE_LAUNCHER: alias, PATH: "C:\\Tools" },
      exists: () => false, readText: () => undefined, listDirectories: () => [], run
    };
    return { options, run, cli };
  }

  it("repairs a legacy Codex command to the Store alias without statting the alias", () => {
    const { options, run, cli } = codexMachine("C:\\OldButler\\node.exe");
    expect(aiClientStatus(options).clients[1]).toMatchObject({ state: "custom", canConnect: true });
    expect(connectAiClient("codex", options)).toMatchObject({ state: "connected" });
    expect(run).toHaveBeenCalledWith(cli, [
      "mcp", "add", "code-butler", "--env", "CODE_BUTLER_HOME=D:\\Butler", "--", alias, "mcp"
    ], expect.any(Object));
  });

  it.each([true, false])("probes the unstatable Store alias and reports MCP health (ok=%s)", async ok => {
    const { options } = codexMachine();
    const result = ok
      ? { ok: true as const, tools: 34, durationMs: 80 }
      : { ok: false as const, reason: "exited" as const, detail: "The alias is disabled.", fix: "Enable the alias." };
    const probe = vi.fn().mockResolvedValue(result);
    const status = await checkedAiClientStatus({ ...options, probe, probeRetryDelayMs: 0 });
    expect(probe).toHaveBeenCalledWith({ command: alias, args: ["mcp"] });
    expect(status.launcherInstalled).toBe(true);
    expect(status.serverCheck).toEqual(result);
    expect(status.clients[1]?.state).toBe(ok ? "connected" : "failing");
  });

  it("keeps standalone Windows installations on their existing Node launcher", () => {
    const launcher = stableLauncher({ platform: "win32", home: "C:\\Users\\dev", env: {} });
    expect(launcher.command).toContain("CodeButler\\node24\\node.exe");
    expect(launcher.args.at(-1)).toBe("mcp");
    expect(store.storeLauncher("win32", { CODE_BUTLER_STORE_LAUNCHER: "relative.exe" })).toBeUndefined();
    expect(store.storeLauncher("darwin", { CODE_BUTLER_STORE_LAUNCHER: alias })).toBeUndefined();
  });

  it("uses Windows startup APIs for status, explicit enable and disable", () => {
    const directory = makeTempDir();
    vi.stubEnv("CODE_BUTLER_HOME", directory);
    vi.stubEnv("CODE_BUTLER_STORE_LAUNCHER", alias);
    const api = vi.spyOn(store, "storeStartup").mockReturnValue({ installed: true, state: 2 });
    const stop = vi.spyOn(watch, "requestGlobalWatchStop").mockImplementation(() => {});
    const legacyRunner = vi.fn();
    const options = { cwd: directory, global: true, platform: "win32" as const, commandRunner: legacyRunner };
    try {
      expect(getWatchServiceStatus(options)).toMatchObject({ installed: true, taskName: "CodeButlerWatcher" });
      expect(installWatchService(options).installed).toBe(true);
      expect(uninstallWatchService(options).installed).toBe(false);
      expect(api.mock.calls).toEqual([["status"], ["enable"], ["disable"]]);
      expect(stop).toHaveBeenCalledOnce();
      expect(legacyRunner).not.toHaveBeenCalled();
    } finally { cleanupTempDir(directory); }
  });

  it("reports a startup task disabled in Windows as disabled", () => {
    vi.stubEnv("CODE_BUTLER_STORE_LAUNCHER", alias);
    vi.spyOn(store, "storeStartup").mockReturnValue({ installed: false, state: 1 });
    expect(getWatchServiceStatus({ cwd: ".", global: true, platform: "win32" }).installed).toBe(false);
  });

  it("propagates a refusal to enable a user-disabled task", () => {
    const directory = makeTempDir();
    vi.stubEnv("CODE_BUTLER_HOME", directory);
    vi.stubEnv("CODE_BUTLER_STORE_LAUNCHER", alias);
    vi.spyOn(store, "storeStartup").mockImplementation(() => { throw new Error("Enable Code Butler watcher in Windows Settings > Apps > Startup"); });
    try {
      expect(() => installWatchService({ cwd: directory, global: true, platform: "win32" }))
        .toThrow("Windows Settings");
    } finally { cleanupTempDir(directory); }
  });
});

describe("standalone to MSIX watcher handoff", () => {
  it("only dispatches installer modes from the installer bundle", () => {
    const root = makeTempDir();
    try {
      for (const [name, installer] of [["install.mjs", true], ["watch.mjs", false]] as const) {
        const entry = join(root, name);
        writeFileSync(entry, "");
        expect(isDesktopRuntimeInstallerEntrypoint(pathToFileURL(entry).href, entry)).toBe(installer);
      }
    } finally { cleanupTempDir(root); }
  });

  function fixture() {
    const directory = makeTempDir();
    vi.stubEnv("CODE_BUTLER_HOME", directory);
    const registration = {
      launcher: "launcher", startup: "startup", nodePath: "node.exe", cliPath: "cli.mjs",
      tasks: [{ name: "CodeButler-watch-global", enabled: true }, { name: "\\CodeButler\\watch-global", enabled: false }]
    };
    const old = {
      pid: 9876, token: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", role: "watcher" as const, startedAt: "old",
      executable: registration.nodePath, entrypoint: registration.cliPath,
      build: { version: "2.0.1", buildId: "legacy", builtAt: "old" }
    };
    const runnerPath = join(directory, "watch", "runner.json");
    const stopPath = join(directory, "watch", "stop.json");
    const watchOptions = { cliPath: "watch.mjs" };
    const platform: NonNullable<Parameters<typeof runStoreWatcher>[1]> = {
      inspect: vi.fn(() => registration),
      verify: vi.fn(() => ["runtime"]),
      verifyProcess: vi.fn(() => "managed" as const),
      change: vi.fn(),
      restart: vi.fn(),
      startupEnabled: vi.fn(() => true),
      projects: vi.fn(() => []),
      watch: vi.fn(async options => options.onReady?.({ ...old, pid: process.pid, build: runtime.buildInfo }))
    };
    return { directory, registration, old, runnerPath, stopPath, watchOptions, platform };
  }

  it("pauses legacy startup paths and only commits after the replacement is ready", async () => {
    const f = fixture();
    try {
      atomicJson(f.runnerPath, f.old);
      vi.spyOn(runtime, "processIsLive").mockImplementation(() => !existsSync(f.stopPath));
      vi.spyOn(f.platform, "watch").mockImplementation(async options => {
        expect(readJson(f.stopPath)).toEqual({ token: f.old.token });
        expect(readJson(store.storeWatcherHandoffPath())).toMatchObject({ state: "starting" });
        expect(existsSync(store.storeWatcherJournalPath())).toBe(true);
        options.onReady?.({ ...f.old, pid: process.pid, build: runtime.buildInfo });
      });
      await runStoreWatcher(f.watchOptions, f.platform);
      expect(f.platform.change).toHaveBeenCalledExactlyOnceWith(f.registration, false);
      expect(f.platform.projects).toHaveBeenCalledOnce();
      expect(f.platform.restart).not.toHaveBeenCalled();
      expect(existsSync(store.storeWatcherJournalPath())).toBe(false);
      expect(existsSync(store.storeWatcherHandoffPath())).toBe(false);
    } finally { cleanupTempDir(f.directory); }
  });

  it("restores the registrations and restarts a drained watcher when startup fails", async () => {
    const f = fixture();
    try {
      atomicJson(f.runnerPath, f.old);
      vi.spyOn(runtime, "processIsLive").mockImplementation(() => !existsSync(f.stopPath));
      vi.spyOn(f.platform, "watch").mockRejectedValue(new Error("Packaged engine failed to start"));
      await expect(runStoreWatcher(f.watchOptions, f.platform)).rejects.toThrow("Packaged engine failed to start");
      expect(f.platform.change).toHaveBeenNthCalledWith(1, f.registration, false);
      expect(f.platform.change).toHaveBeenNthCalledWith(2, f.registration, true);
      expect(f.platform.restart).toHaveBeenCalledExactlyOnceWith(f.registration);
      expect(readJson(store.storeWatcherHandoffPath())).toMatchObject({ state: "rolled-back" });
    } finally { cleanupTempDir(f.directory); }
  });

  it("recovers an interrupted handoff even when packaged startup has since been disabled", async () => {
    const f = fixture();
    try {
      atomicJson(store.storeWatcherJournalPath(), { version: 1, registration: f.registration, runner: f.old });
      atomicJson(f.stopPath, { token: f.old.token });
      vi.spyOn(runtime, "processIsLive").mockReturnValue(false);
      vi.spyOn(f.platform, "startupEnabled").mockReturnValue(false);
      await runStoreWatcher(f.watchOptions, f.platform);
      expect(f.platform.change).toHaveBeenCalledExactlyOnceWith(f.registration, true);
      expect(f.platform.restart).toHaveBeenCalledExactlyOnceWith(f.registration);
      expect(f.platform.watch).not.toHaveBeenCalled();
    } finally { cleanupTempDir(f.directory); }
  });

  it("keeps a single transition open while the standalone watcher drains", async () => {
    const f = fixture();
    let draining = true;
    let paused!: () => void;
    const pause = new Promise<void>(resolve => { paused = resolve; });
    try {
      atomicJson(f.runnerPath, f.old);
      vi.spyOn(runtime, "processIsLive").mockImplementation(() => draining);
      vi.spyOn(f.platform, "change").mockImplementation(() => paused());
      const first = runStoreWatcher(f.watchOptions, f.platform);
      await pause;
      expect(readJson(store.storeWatcherHandoffPath())).toMatchObject({ state: "waiting" });
      await runStoreWatcher(f.watchOptions, f.platform);
      expect(f.platform.watch).not.toHaveBeenCalled();
      draining = false;
      await first;
      expect(f.platform.change).toHaveBeenCalledOnce();
      expect(f.platform.watch).toHaveBeenCalledOnce();
    } finally { cleanupTempDir(f.directory); }
  });

  it.each(["fresh", "disabled", "unverified"] as const)("handles %s startup without retiring an entry", async mode => {
    const f = fixture();
    try {
      if (mode === "fresh") vi.spyOn(f.platform, "inspect").mockReturnValue(undefined);
      if (mode === "disabled") vi.spyOn(f.platform, "startupEnabled").mockReturnValue(false);
      if (mode === "unverified") {
        atomicJson(f.runnerPath, f.old);
        vi.spyOn(runtime, "processIsLive").mockReturnValue(true);
        vi.spyOn(f.platform, "verifyProcess").mockReturnValue("unverified");
        await expect(runStoreWatcher(f.watchOptions, f.platform)).rejects.toThrow("could not be verified");
      } else await runStoreWatcher(f.watchOptions, f.platform);
      expect(f.platform.change).not.toHaveBeenCalled();
      expect(f.platform.watch).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
    } finally { cleanupTempDir(f.directory); }
  });

  it("starts the packaged watcher on later launches when the old task still points at its parked launcher", async () => {
    const f = fixture();
    try {
      vi.spyOn(f.platform, "inspect").mockReturnValue({ ...f.registration, launcherInactive: true });
      await runStoreWatcher(f.watchOptions, f.platform);
      expect(f.platform.change).not.toHaveBeenCalled();
      expect(f.platform.watch).toHaveBeenCalledOnce();
    } finally { cleanupTempDir(f.directory); }
  });
});
