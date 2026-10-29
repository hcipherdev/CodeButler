import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { globalConfigDir } from "../config.js";
import { migrateRegisteredCheckouts, hasIncompleteCheckoutRepairs } from "../cloud/checkout-repair.js";
import { readProjectOperationStatus } from "../cloud/gate.js";
import { atomicJson, readJson } from "../cloud/state.js";
import { listWatchedProjects } from "../global-watch.js";
import { processStartIdentity, runtimeDiagnostics, type BuildInfo, type RuntimeRecord } from "../runtime.js";
import { getWatchServiceStatus, installWatchService, pauseGlobalWatchService, resumeGlobalWatchService, uninstallWatchService } from "../watch-service.js";

interface DesktopEngineManifest {
  protocol: number;
  coreVersion: string;
  build: BuildInfo;
  platform: string;
  arch: string;
  nodeSha256: string;
  hostSha256: string;
  watchSha256: string;
  installerSha256: string;
  nativeManifestSha256: string;
  nativeBinarySha256: string;
  runtimeFilesSha256?: Record<string, string>;
}

export interface DesktopRuntimeInstallOptions {
  engineDirectory?: string;
  installerPath?: string;
  nativeDirectory?: string;
  localAppData?: string;
  configDirectory?: string;
  manageProcesses?: boolean;
  manageWatcher?: boolean;
  updateUserPath?: boolean;
  forceManagedStop?: boolean;
}

export class ManagedRuntimeBlockerError extends Error {
  readonly exitCode = 20;
  constructor(message: string) { super(message); this.name = "ManagedRuntimeBlockerError"; }
}

export interface DesktopRuntimeInstallResult {
  build: BuildInfo;
  releaseDirectory: string;
  cliPath: string;
  nodePath: string;
  stoppedProcesses: number;
  watcherInstalled: boolean;
}

export function installDesktopRuntime(options: DesktopRuntimeInstallOptions = {}): DesktopRuntimeInstallResult {
  const installerPath = resolve(options.installerPath ?? fileURLToPath(import.meta.url));
  const sourceEngine = resolve(options.engineDirectory ?? dirname(installerPath));
  const sourceNative = resolve(options.nativeDirectory ?? join(sourceEngine, "..", "native"));
  const local = resolve(options.localAppData ?? defaultLocalAppData());
  const config = resolve(options.configDirectory ?? globalConfigDir());
  const managedRoot = join(local, "CodeButler", "runtime");
  const legacyRoot = join(local, "CodeButler", "node24");
  const manifest = readManifest(join(sourceEngine, "manifest.json"));

  validateManifest(manifest, sourceEngine, sourceNative, installerPath);
  const release = stageRelease(manifest, sourceEngine, sourceNative, managedRoot);

  const previousRelease = readJson<{ build: BuildInfo; releaseDirectory: string; cliPath: string; nodePath: string }>(join(managedRoot, "current.json"));
  let stoppedProcesses = 0;
  try {
    if (options.manageWatcher !== false) stopGlobalWatcher(config, [legacyRoot, managedRoot], options.forceManagedStop === true);
    if (options.manageProcesses !== false) stoppedProcesses = stopManagedProcesses(runtimeDiagnostics(), [legacyRoot, managedRoot], manifest.build.buildId, config, options.forceManagedStop === true);
    if (options.manageWatcher !== false) handleWatchGateBlocker(config, [legacyRoot, managedRoot], options.forceManagedStop === true);
    if (config === globalConfigDir() && (options.manageProcesses !== false || options.manageWatcher !== false)) {
      pruneDeadProjectLocks();
      migrateRegisteredCheckouts();
    }
  } catch (error) {
    if (config === globalConfigDir() && hasIncompleteCheckoutRepairs()) throw new Error("Checkout repair was interrupted. Run this updater again to resume it before cloud sync starts.", { cause: error });
    if (options.manageWatcher !== false) {
      try {
        if (previousRelease) installWatchService({ cwd: config, global: true, cliPath: previousRelease.cliPath, nodePath: previousRelease.nodePath });
        else resumeGlobalWatchService({ cwd: config, global: true });
      } catch { /* Preserve the blocker reason so the installer can offer the correct choice. */ }
    }
    throw error;
  }

  let watcherInstalled = false;
  try {
    writeCompatibilityLaunchers(legacyRoot, release.nodePath, release.cliPath, manifest.coreVersion);
    writeCurrentRelease(managedRoot, manifest, release);
    if (options.updateUserPath !== false) ensureUserPath(legacyRoot);
    if (options.manageWatcher !== false) {
      installWatchService({ cwd: config, global: true, cliPath: release.cliPath, nodePath: release.nodePath });
      waitForWatcherBuild(config, [legacyRoot, managedRoot], manifest.build.buildId, 20_000);
      watcherInstalled = true;
    }
  } catch (error) {
    if (config === globalConfigDir() && hasIncompleteCheckoutRepairs()) throw new Error("Checkout repair was interrupted. Run this updater again to resume it before cloud sync starts.", { cause: error });
    try {
      if (previousRelease && releaseMatches(previousRelease.releaseDirectory, readManifest(join(previousRelease.releaseDirectory, "engine", "manifest.json")))) {
        writeCompatibilityLaunchers(legacyRoot, previousRelease.nodePath, previousRelease.cliPath, previousRelease.build.version);
        atomicText(join(managedRoot, "current.json"), JSON.stringify(previousRelease, null, 2));
        if (options.manageWatcher !== false) installWatchService({ cwd: config, global: true, cliPath: previousRelease.cliPath, nodePath: previousRelease.nodePath });
      }
    } catch { /* Preserve the original installation error; first launch can retry repair. */ }
    throw error;
  }

  return {
    build: manifest.build,
    releaseDirectory: release.directory,
    cliPath: release.cliPath,
    nodePath: release.nodePath,
    stoppedProcesses,
    watcherInstalled
  };
}

function readManifest(path: string): DesktopEngineManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopEngineManifest>;
  if (
    parsed.protocol !== 1 || !parsed.build?.buildId || !/^[a-f0-9]{64}$/.test(parsed.build.buildId) || !parsed.build.version ||
    parsed.platform !== process.platform || parsed.arch !== process.arch ||
    !parsed.nodeSha256 || !parsed.hostSha256 || !parsed.watchSha256 || !parsed.installerSha256 ||
    !parsed.nativeManifestSha256 || !parsed.nativeBinarySha256
  ) throw new Error("The packaged Code Butler runtime manifest is invalid or incompatible");
  for (const [file, hash] of Object.entries(parsed.runtimeFilesSha256 ?? {})) {
    if (!/^libraries\/[A-Za-z0-9_.+-]+\.dylib$/.test(file) || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("The packaged runtime library manifest is invalid");
    }
  }
  return parsed as DesktopEngineManifest;
}

function validateManifest(manifest: DesktopEngineManifest, engine: string, native: string, installerPath: string): void {
  const executable = join(engine, process.platform === "win32" ? "node.exe" : "node");
  verifyHash(executable, manifest.nodeSha256, "Node runtime");
  verifyHash(join(engine, "host.mjs"), manifest.hostSha256, "desktop host");
  verifyHash(join(engine, "watch.mjs"), manifest.watchSha256, "CLI runtime");
  verifyHash(installerPath, manifest.installerSha256, "runtime installer");
  for (const [file, hash] of Object.entries(manifest.runtimeFilesSha256 ?? {})) verifyHash(join(engine, file), hash, "runtime library");
  const nativePlatform = join(native, `${process.platform}-${process.arch}`);
  const nativeManifest = join(nativePlatform, "manifest.json");
  const nativeMetadata = JSON.parse(readFileSync(nativeManifest, "utf8")) as { binary?: string };
  if (!nativeMetadata.binary || /[\\/]/.test(nativeMetadata.binary)) throw new Error("The packaged native runtime manifest is invalid");
  verifyHash(nativeManifest, manifest.nativeManifestSha256, "native manifest");
  verifyHash(join(nativePlatform, nativeMetadata.binary), manifest.nativeBinarySha256, "native helper");
}

function stageRelease(
  manifest: DesktopEngineManifest,
  sourceEngine: string,
  sourceNative: string,
  managedRoot: string
): { directory: string; cliPath: string; nodePath: string } {
  const releases = join(managedRoot, "releases");
  const directory = join(releases, manifest.build.buildId);
  const engine = join(directory, "engine");
  const nodePath = join(engine, process.platform === "win32" ? "node.exe" : "node");
  const cliPath = join(engine, "cli.mjs");

  if (releaseMatches(directory, manifest)) return { directory, cliPath, nodePath };
  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.${manifest.build.buildId}.staging-${randomUUID()}`);
  try {
    const stagingEngine = join(staging, "engine");
    mkdirSync(stagingEngine, { recursive: true });
    copyFileSync(join(sourceEngine, process.platform === "win32" ? "node.exe" : "node"), join(stagingEngine, process.platform === "win32" ? "node.exe" : "node"));
    for (const file of Object.keys(manifest.runtimeFilesSha256 ?? {})) {
      mkdirSync(dirname(join(stagingEngine, file)), { recursive: true });
      copyFileSync(join(sourceEngine, file), join(stagingEngine, file));
    }
    // Preserve compatibility with previously packaged Homebrew Node runtimes.
    if (process.platform === "darwin" && existsSync(join(sourceEngine, "libnode.137.dylib"))) {
      copyFileSync(join(sourceEngine, "libnode.137.dylib"), join(stagingEngine, "libnode.137.dylib"));
    }
    copyFileSync(join(sourceEngine, "host.mjs"), join(stagingEngine, "host.mjs"));
    copyFileSync(join(sourceEngine, "watch.mjs"), join(stagingEngine, "cli.mjs"));
    copyFileSync(join(sourceEngine, "install.mjs"), join(stagingEngine, "install.mjs"));
    copyFileSync(join(sourceEngine, "manifest.json"), join(stagingEngine, "manifest.json"));
    if (existsSync(sourceNative)) cpSync(sourceNative, join(staging, "native"), { recursive: true });
    if (process.platform !== "win32") chmodSync(join(stagingEngine, "node"), 0o755);
    if (!releaseMatches(staging, manifest)) throw new Error("The staged Code Butler runtime failed integrity verification");
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { directory, cliPath, nodePath };
}

function releaseMatches(directory: string, manifest: DesktopEngineManifest): boolean {
  try {
    const engine = join(directory, "engine");
    return digest(join(engine, process.platform === "win32" ? "node.exe" : "node")) === manifest.nodeSha256
      && digest(join(engine, "host.mjs")) === manifest.hostSha256
      && digest(join(engine, "cli.mjs")) === manifest.watchSha256
      && digest(join(engine, "install.mjs")) === manifest.installerSha256
      && Object.entries(manifest.runtimeFilesSha256 ?? {}).every(([file, hash]) => digest(join(engine, file)) === hash)
      && nativeReleaseMatches(directory, manifest);
  } catch { return false; }
}

function nativeReleaseMatches(directory: string, manifest: DesktopEngineManifest): boolean {
  const nativePlatform = join(directory, "native", `${process.platform}-${process.arch}`);
  const nativeManifest = join(nativePlatform, "manifest.json");
  const metadata = JSON.parse(readFileSync(nativeManifest, "utf8")) as { binary?: string };
  return !!metadata.binary && !/[\\/]/.test(metadata.binary)
    && digest(nativeManifest) === manifest.nativeManifestSha256
    && digest(join(nativePlatform, metadata.binary)) === manifest.nativeBinarySha256;
}

function stopGlobalWatcher(configDirectory: string, roots: string[], force: boolean): void {
  const options = { cwd: configDirectory, global: true } as const;
  pauseGlobalWatchService(options);
  const runner = readJson<RuntimeRecord>(join(configDirectory, "watch", "runner.json"));
  if (runner?.pid) {
    let state = managedWatcherState(runner, roots);
    if (state === "unverified") throw new Error(`Watcher PID ${runner.pid} is running, but its identity could not be verified as the managed Code Butler watcher. No process was terminated; close the watcher and retry.`);
    const deadline = Date.now() + (force ? 2_000 : 30_000);
    while (state === "managed" && Date.now() < deadline) {
      sleep(500);
      state = managedWatcherState(runner, roots);
      if (state === "unverified") throw new Error(`Watcher PID ${runner.pid} changed identity while installation was waiting. No process was terminated; retry the installation.`);
    }
    if (state === "managed") {
      const locked = listWatchedProjects().some(project => !!readProjectOperationStatus(project.root));
      if (!force) throw new ManagedRuntimeBlockerError(locked
        ? `Code Butler watcher (PID ${runner.pid}) is still using a project database. Force install will end that work.`
        : `Code Butler watcher (PID ${runner.pid}) did not stop after 30 seconds. It may be finishing model or network work. Force install will end that work.`);
      // Recheck just before termination so a reused PID cannot target another app.
      if (managedWatcherState(runner, roots) !== "managed") throw new Error(`Watcher PID ${runner.pid} changed identity before it could be stopped; retry the installation.`);
      try { process.kill(runner.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const exitDeadline = Date.now() + 10_000;
      while (managedWatcherState(runner, roots) === "managed" && Date.now() < exitDeadline) sleep(500);
      if (managedWatcherState(runner, roots) === "managed") throw new Error(`Code Butler watcher (PID ${runner.pid}) did not exit after force install requested termination.`);
    }
  }
  if (getWatchServiceStatus(options).installed) uninstallWatchService(options);
}

export function managedWatcherState(runner: RuntimeRecord, roots: string[]): "stale" | "managed" | "unverified" {
  if (!Number.isSafeInteger(runner.pid) || runner.pid <= 0 || !isPidPresent(runner.pid)) return "stale";
  const currentBirth = processStartIdentity(runner.pid);
  if (currentBirth && runner.processStart && !sameProcessBirth(currentBirth, runner.processStart)) return "stale";
  if (!runner.processStart || !currentBirth || runner.role !== "watcher" ||
    !roots.some(root => containedBy(runner.executable, root) && containedBy(runner.entrypoint, root))) return "unverified";
  const current = managedProcessInventory(roots).find(process => process.pid === runner.pid &&
    sameProcessBirth(process.processStart, runner.processStart) &&
    process.executable.toLowerCase() === runner.executable.toLowerCase() &&
    process.commandLine.toLowerCase().includes(runner.entrypoint.toLowerCase()) &&
    /\bcli\.(?:mjs|js)["']?\s+watch\s+--global\b/i.test(process.commandLine));
  return current ? "managed" : "unverified";
}

interface ManagedProcess { pid: number; processStart?: string; executable: string; commandLine: string }
function managedProcessInventory(roots: string[]): ManagedProcess[] {
  if (process.platform !== "win32") return runtimeDiagnostics().flatMap(record => {
    if (!record.processStart || !isPidPresent(record.pid) || !sameProcessBirth(record.processStart, processStartIdentity(record.pid))) return [];
    try {
      const executable = process.platform === "linux"
        ? realpathSync(`/proc/${record.pid}/exe`)
        : execFileSync("ps", ["-ww", "-p", String(record.pid), "-o", "comm="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
      const commandLine = process.platform === "linux"
        ? readFileSync(`/proc/${record.pid}/cmdline`, "utf8").replaceAll("\0", " ")
        : execFileSync("ps", ["-ww", "-p", String(record.pid), "-o", "args="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
      if (realpathSync(executable) !== realpathSync(record.executable) ||
        !roots.some(root => containedBy(executable, root) && containedBy(record.entrypoint, root)) ||
        !commandLine.includes(record.entrypoint)) return [];
      return [{ pid: record.pid, processStart: record.processStart, executable, commandLine }];
    } catch { return []; } // An inaccessible process is never safe to terminate.
  });
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;processStart=$_.CreationDate.ToUniversalTime().Ticks.ToString();executable=$_.ExecutablePath;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress";
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (!output.trim()) return [];
  const parsed = JSON.parse(output) as ManagedProcess | ManagedProcess[] | null;
  return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter(process =>
    Number.isSafeInteger(process.pid) && !!process.processStart && !!process.executable && !!process.commandLine &&
    roots.some(root => containedBy(process.executable, root)));
}
function sameProcessBirth(first?: string, second?: string): boolean {
  if (!first || !second) return false;
  // macOS reports a ps start-time string; Linux reports /proc clock ticks.
  // Only Windows needs the CIM/.NET rounding tolerance below.
  if (process.platform !== "win32") return first === second;
  if (!/^\d+$/.test(first) || !/^\d+$/.test(second)) return false;
  // CIM CreationDate is rounded to microseconds; Get-Process StartTime keeps
  // finer .NET ticks. A millisecond remains precise enough to prevent PID reuse.
  const difference = BigInt(first) - BigInt(second);
  return difference > -10_000n && difference < 10_000n;
}
export function handleWatchGateBlocker(config: string, roots: string[], force: boolean): void {
  const status = readProjectOperationStatus(join(config, "watch"));
  if (!status || !isPidPresent(status.pid)) return;
  const currentBirth = processStartIdentity(status.pid);
  const managed = managedProcessInventory(roots).find(process => process.pid === status.pid &&
    sameProcessBirth(process.processStart, currentBirth) &&
    /\bcli\.(?:mjs|js)["']?\s+(?:mcp\b|watch\s+--global\b)/i.test(process.commandLine));
  if (!managed) throw new Error(`The watcher cannot start because its operation lock is held by PID ${status.pid}, which could not be verified as a managed Code Butler process. Close that process and retry; no process was terminated.`);
  if (!force) throw new ManagedRuntimeBlockerError(`The watcher cannot start because its operation lock is held by a managed Code Butler process (PID ${status.pid}). Force install will terminate that process.`);
  // The lock and process may change while the dialog is open; verify again.
  const latest = readProjectOperationStatus(join(config, "watch"));
  if (latest?.pid !== status.pid || !managedProcessInventory(roots).some(process => process.pid === status.pid &&
    sameProcessBirth(process.processStart, currentBirth) && process.commandLine === managed.commandLine))
    throw new Error("The watcher operation lock changed before the blocking process could be stopped; retry installation.");
  try { process.kill(status.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const deadline = Date.now() + 10_000;
  while (isPidPresent(status.pid) && sameProcessBirth(processStartIdentity(status.pid), currentBirth) && Date.now() < deadline) sleep(500);
  if (isPidPresent(status.pid) && sameProcessBirth(processStartIdentity(status.pid), currentBirth))
    throw new Error(`The managed Code Butler process (PID ${status.pid}) did not exit after force install requested termination.`);
}
function stopManagedProcesses(records: RuntimeRecord[], roots: string[], newBuild: string, config: string, force: boolean): number {
  const inventory = managedProcessInventory(roots);
  const known = records.filter(record => record.pid !== process.pid && record.role !== "legacy-watcher" && record.build?.buildId !== newBuild &&
    roots.some(root => containedBy(record.entrypoint, root) && containedBy(record.executable, root)) &&
    inventory.some(process => process.pid === record.pid && sameProcessBirth(process.processStart, record.processStart) &&
      process.commandLine.toLowerCase().includes(record.entrypoint.toLowerCase())));
  const discovered: RuntimeRecord[] = inventory.filter(candidate => candidate.pid !== process.pid &&
    !records.some(record => record.pid === candidate.pid) && !candidate.executable.toLowerCase().includes(newBuild.toLowerCase()) &&
    roots.some(root => candidate.commandLine.toLowerCase().includes(root.toLowerCase())) &&
    /\bcli\.(?:mjs|js)["']?\s+(?:mcp\b|watch\s+--global\b)/i.test(candidate.commandLine)).map(candidate => ({
      pid: candidate.pid, ...(candidate.processStart ? { processStart: candidate.processStart } : {}), executable: candidate.executable, entrypoint: candidate.executable,
      token: "", startedAt: "", role: /\bwatch\s+--global\b/i.test(candidate.commandLine) ? "watcher" : "mcp",
      build: { version: "unknown", buildId: "unknown", builtAt: "unknown" }
    }));
  const candidates = [...known, ...discovered];
  for (const record of candidates.filter(record => record.role === "mcp" && record.token))
    atomicJson(join(config, "runtime-stop", `${record.token}.json`), { token: record.token });
  const deadline = Date.now() + 30_000;
  while (candidates.some(record => isPidPresent(record.pid)) && Date.now() < deadline) sleep(250);
  const remaining = managedProcessInventory(roots);
  let stopped = 0;
  for (const record of candidates) {
    const current = remaining.find(process => process.pid === record.pid && sameProcessBirth(process.processStart, record.processStart));
    if (!current) { stopped++; continue; }
    const locked = listWatchedProjects().some(project => readProjectOperationStatus(project.root)?.pid === record.pid);
    if (!force) throw new ManagedRuntimeBlockerError(locked
      ? `Managed Code Butler ${record.role} (PID ${record.pid}) is still using a project database. Force install will end that work.`
      : `Managed Code Butler ${record.role} (PID ${record.pid}) did not stop after 30 seconds. Force install will end that process.`);
    const verified = managedProcessInventory(roots).some(process => process.pid === record.pid &&
      sameProcessBirth(process.processStart, record.processStart) && process.commandLine === current.commandLine);
    if (!verified) continue;
    try { process.kill(record.pid, "SIGTERM"); stopped++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const exitDeadline = Date.now() + 10_000;
  while (candidates.some(record => isPidPresent(record.pid) && sameProcessBirth(processStartIdentity(record.pid), record.processStart)) && Date.now() < exitDeadline) sleep(500);
  if (candidates.some(record => isPidPresent(record.pid) && sameProcessBirth(processStartIdentity(record.pid), record.processStart))) throw new Error("An old managed Code Butler process did not exit after replacement");
  for (const record of candidates) if (record.token) {
    const runtimePath = join(config, "runtimes", `${record.token}.json`);
    if (readJson<RuntimeRecord>(runtimePath)?.token === record.token) {
      try { unlinkSync(runtimePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const requestPath = join(config, "runtime-stop", `${record.token}.json`);
    if (readJson<{ token: string }>(requestPath)?.token === record.token) {
      try { unlinkSync(requestPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return stopped;
}
function isPidPresent(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  try {
    // A Unix child remains visible until its parent reaps it, even though it
    // has already exited. In particular, kill(pid, 0) succeeds for zombies.
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] !== "Z";
    if (process.platform === "darwin") return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], {encoding:"utf8", timeout:5000, stdio:["ignore", "pipe", "ignore"], windowsHide:true}).trim().startsWith("Z");
  } catch { /* An unavailable query is not evidence that a process is dead. */ }
  return true;
}
function pruneDeadProjectLocks(): void {
  for (const project of listWatchedProjects()) {
    const lock = join(project.root, ".code-butler", ".cloud-operation.lock");
    let owner: { pid: number; token: string } | undefined;
    try { owner = readJson<{ pid: number; token: string }>(lock); } catch { continue; }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.token)) continue;
    try { process.kill(owner.pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    let stillOwned = false;
    try { stillOwned = readJson<{ token: string }>(lock)?.token === owner.token; } catch { /* Preserve an unreadable lock. */ }
    if (stillOwned) {
      try { unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
function waitForWatcherBuild(config: string, roots: string[], buildId: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  do {
    const runner = readJson<RuntimeRecord>(join(config, "watch", "runner.json"));
    if (runner?.build?.buildId === buildId && isPidPresent(runner.pid) &&
      managedProcessInventory(roots).some(process => process.pid === runner.pid && sameProcessBirth(process.processStart, runner.processStart))) return;
    sleep(500);
  } while (Date.now() < deadline);
  handleWatchGateBlocker(config, roots, false);
  throw new Error(`The new Code Butler watcher did not register within ${Math.round(timeoutMs / 1000)} seconds. No verified process is holding its operation lock. Check ${join(config, "watch", "logs", "watch.err.log")} for startup errors, then retry installation.`);
}

function writeCompatibilityLaunchers(legacyRoot: string, nodePath: string, cliPath: string, version: string): void {
  const packageRoot = join(legacyRoot, "node_modules", "code-butler");
  const dist = join(packageRoot, "dist");
  mkdirSync(dist, { recursive: true });
  atomicText(join(packageRoot, "package.json"), JSON.stringify({ name: "code-butler", version, type: "module", bin: { "code-butler": "dist/cli.js" } }, null, 2));
  atomicText(join(dist, "cli.js"), legacyModuleShim(nodePath, cliPath));
  atomicText(join(legacyRoot, "code-butler.cmd"), `@ECHO off\r\n"${nodePath}" "${cliPath}" %*\r\n`);
  atomicText(join(legacyRoot, "code-butler.ps1"), `#!/usr/bin/env pwsh\n& '${powershellLiteral(nodePath)}' '${powershellLiteral(cliPath)}' @args\nexit $LASTEXITCODE\n`);
  const shell = join(legacyRoot, "code-butler");
  atomicText(shell, `#!/bin/sh\nexec '${shellLiteral(nodePath)}' '${shellLiteral(cliPath)}' "$@"\n`);
  if (process.platform !== "win32") chmodSync(shell, 0o755);
  const legacyNode = join(legacyRoot, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "darwin") {
    // A copied Node binary would lose its adjacent dylibs. Old MCP configs that
    // invoke node24/node must also reach the complete versioned runtime.
    atomicText(legacyNode, `#!/bin/sh\nexec '${shellLiteral(nodePath)}' "$@"\n`);
    chmodSync(legacyNode, 0o755);
  } else if (!existsSync(legacyNode)) copyFileSync(nodePath, legacyNode);
}

function legacyModuleShim(nodePath: string, cliPath: string): string {
  return `import { spawn } from "node:child_process";\n`
    + `const child = spawn(${JSON.stringify(nodePath)}, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env: process.env });\n`
    + `child.on("error", error => { console.error(error.message); process.exitCode = 1; });\n`
    + `child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });\n`;
}

function writeCurrentRelease(
  managedRoot: string,
  manifest: DesktopEngineManifest,
  release: { directory: string; cliPath: string; nodePath: string }
): void {
  mkdirSync(managedRoot, { recursive: true });
  atomicText(join(managedRoot, "current.json"), JSON.stringify({
    build: manifest.build,
    releaseDirectory: release.directory,
    cliPath: release.cliPath,
    nodePath: release.nodePath,
    installedAt: new Date().toISOString()
  }, null, 2));
}

function ensureUserPath(directory: string): void {
  if (process.platform !== "win32") return;
  execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$target=$env:CODE_BUTLER_RUNTIME_BIN; $current=[Environment]::GetEnvironmentVariable('Path','User'); "
      + "$parts=@($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }); "
      + "if(-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $target.TrimEnd('\\') })) { "
      + "$next=(@($parts)+$target)-join ';'; [Environment]::SetEnvironmentVariable('Path',$next,'User') }"
  ], {
    env: { ...process.env, CODE_BUTLER_RUNTIME_BIN: directory },
    windowsHide: true,
    stdio: "ignore",
    timeout: 15_000
  });
}

function defaultLocalAppData(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function verifyHash(path: string, expected: string, label: string): void {
  if (digest(path) !== expected) throw new Error(`The packaged ${label} failed integrity verification`);
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function atomicText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  try {
    rmSync(path, { force: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function containedBy(path: string, root: string): boolean {
  const candidate = normalize(resolve(path)).toLowerCase();
  const parent = normalize(resolve(root)).toLowerCase();
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function powershellLiteral(value: string): string { return value.replaceAll("'", "''"); }
function shellLiteral(value: string): string { return value.replaceAll("'", `'"'"'`); }
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

export function isDesktopRuntimeInstallerEntrypoint(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argvPath); }
  catch { return false; }
}

if (isDesktopRuntimeInstallerEntrypoint(import.meta.url, process.argv[1])) {
  try {
    if (process.argv.slice(2).some(argument => argument !== "--force-managed-stop")) throw new Error("Unknown runtime installer option");
    console.log(JSON.stringify(installDesktopRuntime({ forceManagedStop: process.argv.includes("--force-managed-stop") })));
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Code Butler runtime installation failed");
    process.exitCode = error instanceof ManagedRuntimeBlockerError ? error.exitCode : 1;
  }
}
