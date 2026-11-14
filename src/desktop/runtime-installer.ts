import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { globalConfigDir } from "../config.js";
import { hasIncompleteCheckoutRepairs } from "../cloud/checkout-repair.js";
import { readProjectOperationStatus, withProjectGateSync } from "../cloud/gate.js";
import { atomicJson, readJson } from "../cloud/state.js";
import { OperationDeferredError } from "../cloud/outcome.js";
import { processStartIdentity, readRuntimeRecords, type BuildInfo, type RuntimeRecord } from "../runtime.js";
import { probeMcpLauncher } from "./mcp-probe.js";
import { getWatchServiceStatus, installWatchService, pauseGlobalWatchService, readGlobalWatchRegistration, restoreGlobalWatchRegistration, uninstallWatchService, type GlobalWatchRegistration } from "../watch-service.js";

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
  idleOnly?: boolean;
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

interface CurrentRelease { build: BuildInfo; releaseDirectory: string; cliPath: string; nodePath: string }
export interface RuntimeUpgradePreflight {
  state: "fresh" | "current" | "upgrade" | "blocked";
  current?: BuildInfo;
  target: BuildInfo;
  affected: Array<{ pid: number; role: "watcher" | "mcp" }>;
  reason?: string;
  recoverable?: boolean;
}

function runtimePaths(options: DesktopRuntimeInstallOptions) {
  const installerPath = resolve(options.installerPath ?? fileURLToPath(import.meta.url));
  const sourceEngine = resolve(options.engineDirectory ?? dirname(installerPath));
  const sourceNative = resolve(options.nativeDirectory ?? join(sourceEngine, "..", "native"));
  const local = resolve(options.localAppData ?? defaultLocalAppData());
  const config = resolve(options.configDirectory ?? globalConfigDir());
  const managedRoot = join(local, "CodeButler", "runtime");
  const legacyRoot = join(local, "CodeButler", "node24");
  return { installerPath, sourceEngine, sourceNative, config, managedRoot, legacyRoot, manifest: readManifest(join(sourceEngine, "manifest.json")) };
}

export function preflightDesktopRuntime(options: DesktopRuntimeInstallOptions = {}): RuntimeUpgradePreflight {
  return inspectUpgrade(runtimePaths(options), options).report;
}

function inspectUpgrade(paths: ReturnType<typeof runtimePaths>, options: DesktopRuntimeInstallOptions) {
  const { config, managedRoot, legacyRoot, manifest } = paths;
  const currentPath = join(managedRoot, "current.json");
  const current = readJson<CurrentRelease>(currentPath);
  const watcher = options.manageWatcher === false ? undefined : readJson<RuntimeRecord>(join(config, "watch", "runner.json"));
  const records = options.manageProcesses === false ? [] : readRuntimeRecords(config);
  const roots = [legacyRoot, managedRoot];
  const report: RuntimeUpgradePreflight = { state: "fresh", target: manifest.build, affected: [] };
  if (current?.build) report.current = current.build;
  const activeUpgrade = readProjectOperationStatus(managedRoot);
  if (activeUpgrade && activeUpgrade.pid !== process.pid) {
    report.state = "blocked";
    report.reason = "Another Code Butler setup is changing the shared runtime. Wait for it to finish and retry.";
    return { report, records, watcher, registration: undefined, verified: new Map<number, string | undefined>() };
  }
  if (existsSync(runtimeBackupPath(managedRoot))) {
    report.state = "blocked";
    report.recoverable = true;
    report.reason = "An earlier upgrade was interrupted. Restore the previous installation and retry.";
    return { report, records, watcher, registration: undefined, verified: new Map<number, string | undefined>() };
  }
  const installedManifest = current && containedBy(current.releaseDirectory, managedRoot)
    ? readJson<DesktopEngineManifest>(join(current.releaseDirectory, "engine", "manifest.json")) : undefined;
  if (current?.build?.buildId === manifest.build.buildId && installedManifest?.build?.buildId === manifest.build.buildId &&
      installedManifest.nodeSha256 === manifest.nodeSha256 &&
      installedManifest.nativeBinarySha256 === manifest.nativeBinarySha256 &&
      Object.keys(manifest.runtimeFilesSha256 ?? {}).every(file => existsSync(join(current.releaseDirectory, "engine", file))) && containedBy(current.nodePath, current.releaseDirectory) &&
      containedBy(current.cliPath, current.releaseDirectory) && existsSync(current.nodePath) && existsSync(current.cliPath) &&
      existsSync(join(legacyRoot, "code-butler")) && (!watcher || watcher.build?.buildId === manifest.build.buildId) &&
      (options.manageWatcher === false || getWatchServiceStatus({ cwd: config, global: true }).installed)) {
    report.state = "current";
    return { report, records, watcher, registration: undefined, verified: new Map<number, string | undefined>() };
  }

  let registration: GlobalWatchRegistration | undefined;
  if (options.manageWatcher !== false) {
    try { registration = inspectWatchRegistration(config, roots); }
    catch (error) { report.reason = error instanceof Error ? error.message : "The watcher service registration could not be verified."; }
  }
  const installed = existsSync(currentPath) || existsSync(legacyRoot) || watcher ||
    records.some(record => record.role !== "legacy-watcher") || registration?.files.length || registration?.tasks.length || registration?.loaded;
  if (installed) report.state = "upgrade";
  let inventory: ManagedProcess[] = [];
  try { if (installed) inventory = managedProcessInventory(roots, watcher ? [...records, watcher] : records); }
  catch { report.reason ??= "Windows process details could not be read. Close Code Butler and any connected tools, then retry."; }
  const watcherState = watcher && inspectWatcher(watcher, roots, inventory);
  if (watcherState?.reason) report.reason ??= watcherState.reason;
  const unverifiedMcp = unverifiedMcpProcess(records, roots, inventory);
  if (unverifiedMcp) report.reason ??= unverifiedMcp;
  const affected = runtimeCandidates(records, roots, inventory);
  const watchProcess = watcher && watcherState?.state === "managed" && inventory.find(process => process.pid === watcher.pid && matchesRecord(process, watcher));
  report.affected = [...new Map([...affected, ...(watchProcess && watcher ? [watcher] : [])].map(record => [record.pid,
    { pid: record.pid, role: record.role === "watcher" ? "watcher" as const : "mcp" as const }])).values()];
  const gate = options.manageWatcher === false ? undefined : readProjectOperationStatus(join(config, "watch"));
  if (gate && !report.affected.some(record => record.pid === gate.pid && record.role === "watcher")) {
    report.reason ??= `Watcher lock PID ${gate.pid} could not be verified as the registered Code Butler watcher. Close the process holding the lock and retry.`;
  }
  if (config === globalConfigDir() && options.manageWatcher !== false && hasIncompleteCheckoutRepairs()) {
    report.reason ??= "A project connection repair is incomplete. Finish the repair in your current version, then retry.";
  }
  if (report.reason) report.state = "blocked";
  return { report, records, watcher, registration, verified: new Map([...affected, ...(watchProcess && watcher ? [watcher] : [])]
    .map(record => [record.pid, record.processStart])) };
}

/** Notice evidence survives when the installer switches the runtime before the first app launch. */
export function desktopRuntimeNotice(options: DesktopRuntimeInstallOptions = {}): string | undefined {
  const { managedRoot, legacyRoot, manifest } = runtimePaths(options);
  const target = manifest.build.buildId;
  const currentPath = join(managedRoot, "current.json");
  const current = readJson<CurrentRelease>(currentPath);
  // A fresh setup writes its launchers before current.json. The transaction
  // distinguishes those launchers from a legacy install without a pointer.
  const upgradingLegacy = !current && replacesInstalledRuntime(undefined, legacyRoot, target) &&
    !existsSync(runtimeBackupPath(managedRoot)) && !existsSync(currentPath);
  const saved = readJson<{ buildId?: string }>(runtimeNoticePath(managedRoot));
  return saved?.buildId === target || upgradingLegacy || (current && replacesInstalledRuntime(current, legacyRoot, target))
    ? target : undefined;
}

function replacesInstalledRuntime(current: CurrentRelease | undefined, legacyRoot: string, target: string): boolean {
  const installed = current?.build?.buildId;
  return installed ? installed !== target : ["code-butler", "code-butler.cmd", "code-butler.ps1"]
    .some(name => existsSync(join(legacyRoot, name)));
}

const runtimeNoticePath = (root: string) => join(root, "last-upgrade.json");

export function installDesktopRuntime(options: DesktopRuntimeInstallOptions = {}): DesktopRuntimeInstallResult {
  const paths = runtimePaths(options);
  const { managedRoot } = paths;
  mkdirSync(managedRoot, { recursive: true });
  return withProjectGateSync(managedRoot, () => activateDesktopRuntime(paths, options), "Update Code Butler runtime");
}

function activateDesktopRuntime(paths: ReturnType<typeof runtimePaths>, options: DesktopRuntimeInstallOptions): DesktopRuntimeInstallResult {
  const { installerPath, sourceEngine, sourceNative, config, managedRoot, legacyRoot, manifest } = paths;
  const interrupted = readJson<RuntimeBackup>(runtimeBackupPath(managedRoot));
  if (interrupted) {
    if (options.idleOnly) throw new ManagedRuntimeBlockerError("A shared runtime upgrade is awaiting recovery.");
    restoreRuntimeBackup(paths, interrupted);
  }
  const { report, watcher, verified, registration } = inspectUpgrade(paths, options);
  if (report.state === "blocked") throw new ManagedRuntimeBlockerError(report.reason ?? "Shared runtime setup was deferred.");
  if (options.idleOnly && report.affected.length) {
    throw new ManagedRuntimeBlockerError("Shared runtime setup was deferred while Code Butler processes are active.");
  }

  validateManifest(manifest, sourceEngine, sourceNative, installerPath);
  const current = readJson<CurrentRelease>(join(managedRoot, "current.json"));
  if (report.state === "current" && current) return { build: manifest.build, releaseDirectory: current.releaseDirectory,
    cliPath: current.cliPath, nodePath: current.nodePath, stoppedProcesses: 0,
    watcherInstalled: options.manageWatcher !== false && getWatchServiceStatus({ cwd: config, global: true }).installed };
  const release = stageRelease(manifest, sourceEngine, sourceNative, managedRoot, current?.releaseDirectory);
  if (replacesInstalledRuntime(current, legacyRoot, manifest.build.buildId)) {
    atomicJson(runtimeNoticePath(managedRoot), { buildId: manifest.build.buildId });
  }

  const roots = [legacyRoot, managedRoot];
  const backup = beginRuntimeBackup(paths, watcher, registration);
  const watchOptions = { cwd: config, global: true } as const;
  const activation = join(config, "watch", "runtime-activation.json");
  let stoppedProcesses = 0;
  let watcherInstalled = false;
  const deadline = Date.now() + (options.idleOnly ? 0 : 30_000);
  const stopRequests: string[] = [];
  try {
    if (options.manageWatcher !== false) {
      if (JSON.stringify(registration) !== JSON.stringify(inspectWatchRegistration(config, roots))) {
        throw new ManagedRuntimeBlockerError("The watcher service changed during shared runtime setup.");
      }
      backup.watcherPaused = true;
      saveRuntimeBackup(managedRoot, backup);
      stopGlobalWatcher(config, roots, verified, deadline, options.idleOnly === true);
      handleWatchGateBlocker(config, roots);
    }
    if (options.manageProcesses !== false) {
      const candidates = inspectManagedConnections(config, roots);
      if (candidates.some(record => !sameProcessBirth(verified.get(record.pid), record.processStart))) {
        throw new ManagedRuntimeBlockerError("A Butler connection opened during shared runtime setup.");
      }
      backup.mcpStopTokens = candidates.filter(record => record.role === "mcp" && record.token).map(record => record.token);
      saveRuntimeBackup(managedRoot, backup);
      for (const token of backup.mcpStopTokens) {
        const path = join(config, "runtime-stop", `${token}.json`);
        atomicJson(path, { token });
        stopRequests.push(path);
      }
      stoppedProcesses = waitForManagedConnections(candidates, roots, config, deadline);
    }
    if (config === globalConfigDir() && options.manageWatcher !== false && hasIncompleteCheckoutRepairs()) {
      throw new ManagedRuntimeBlockerError("A project connection repair is incomplete.");
    }
    backup.filesChanging = true;
    saveRuntimeBackup(managedRoot, backup);
    if (options.manageWatcher !== false) {
      backup.activationPending = true;
      saveRuntimeBackup(managedRoot, backup);
      atomicJson(activation, { buildId: manifest.build.buildId, token: randomUUID() });
    }
    writeCompatibilityLaunchers(legacyRoot, release.nodePath, release.cliPath, manifest.coreVersion);
    writeCurrentRelease(managedRoot, manifest, release);
    if (options.manageWatcher !== false) {
      backup.newWatcher = true;
      saveRuntimeBackup(managedRoot, backup);
      installWatchService({ ...watchOptions, cliPath: release.cliPath, nodePath: release.nodePath });
      waitForWatcherBuild(config, [legacyRoot, managedRoot], manifest.build.buildId, 20_000);
      execFileSync(release.nodePath, [join(release.directory, "engine", "install.mjs"), "--probe", legacyRoot, manifest.build.buildId], {
        timeout: 20_000, stdio: ["ignore", "ignore", "pipe"], windowsHide: true
      });
      watcherInstalled = true;
    }
    if (options.updateUserPath !== false) ensureUserPath(legacyRoot);
    backup.committed = true;
    saveRuntimeBackup(managedRoot, backup);
  } catch (error) {
    try { restoreRuntimeBackup(paths, backup); }
    catch (rollback) { throw new Error("Could not restore the previous installation. Shared runtime setup will retry recovery on the next launch.", { cause: rollback }); }
    throw error;
  } finally {
    for (const path of stopRequests) {
      try { rmSync(path, { force: true }); } catch { /* An exited process cannot reuse a stop token. */ }
    }
  }
  finishRuntimeBackup(paths, backup);

  return {
    build: manifest.build,
    releaseDirectory: release.directory,
    cliPath: release.cliPath,
    nodePath: release.nodePath,
    stoppedProcesses,
    watcherInstalled
  };
}

interface RuntimeBackup {
  files: Array<{ path: string; existed: boolean }>;
  mcpStopTokens?: string[];
  previousWatcher?: GlobalWatchRegistration;
  watcherToken?: string;
  watcherPaused?: boolean;
  newWatcher?: boolean;
  activationPending?: boolean;
  filesChanging?: boolean;
  committed?: boolean;
}

const runtimeBackupPath = (root: string) => join(root, "upgrade-transaction.json");
const runtimeBackupFiles = (root: string) => join(root, "upgrade-backup");
function saveRuntimeBackup(root: string, backup: RuntimeBackup): void { atomicJson(runtimeBackupPath(root), backup); }

function runtimeFiles({ managedRoot, legacyRoot }: ReturnType<typeof runtimePaths>): string[] {
  return [join(managedRoot, "current.json"), ...["node", "node.exe", "code-butler", "code-butler.cmd", "code-butler.ps1",
    "node_modules/code-butler/package.json", "node_modules/code-butler/dist/cli.js"].map(name => join(legacyRoot, name))];
}

function assertRuntimeFile(path: string, { managedRoot, legacyRoot }: ReturnType<typeof runtimePaths>): void {
  for (let parent = path; [managedRoot, legacyRoot].some(root => containedBy(parent, root)); parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Setup cannot follow a link at ${parent}.`);
  }
}

function beginRuntimeBackup(paths: ReturnType<typeof runtimePaths>, watcher?: RuntimeRecord, registration?: GlobalWatchRegistration): RuntimeBackup {
  const backupDirectory = runtimeBackupFiles(paths.managedRoot);
  rmSync(backupDirectory, { recursive: true, force: true });
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const files = runtimeFiles(paths).map((path, index) => {
    assertRuntimeFile(path, paths);
    const existed = existsSync(path);
    if (existed) {
      if (!lstatSync(path).isFile()) throw new Error(`Setup cannot safely replace ${path}.`);
      cpSync(path, join(backupDirectory, String(index)));
    }
    return { path, existed };
  });
  const backup: RuntimeBackup = { files,
    ...(watcher?.token ? { watcherToken: watcher.token } : {}),
    ...(registration ? { previousWatcher: registration } : {}) };
  saveRuntimeBackup(paths.managedRoot, backup);
  return backup;
}

function finishRuntimeBackup({ managedRoot, config }: ReturnType<typeof runtimePaths>, backup: RuntimeBackup): void {
  if (backup.activationPending) rmSync(join(config, "watch", "runtime-activation.json"), { force: true });
  rmSync(runtimeBackupPath(managedRoot), { force: true });
  rmSync(runtimeBackupFiles(managedRoot), { recursive: true, force: true });
}

function restoreRuntimeBackup(paths: ReturnType<typeof runtimePaths>, backup: RuntimeBackup): void {
  const { managedRoot, config } = paths;
  if (backup.committed) { finishRuntimeBackup(paths, backup); return; }
  const watchOptions = { cwd: config, global: true } as const;
  // The replacement watcher is waiting behind runtime-activation.json, before it can touch a project.
  if (backup.newWatcher) {
    inspectWatchRegistration(config, [paths.legacyRoot, managedRoot]);
    uninstallWatchService({ ...watchOptions, requireUnloaded: true });
  }
  // An interrupted older NSIS upgrade also recorded desktop files. The standard
  // installer owns those files now, so runtime recovery restores only runtime paths.
  const owned = new Set(runtimeFiles(paths));
  if (backup.filesChanging) for (const [index, file] of backup.files.entries()) {
    if (!owned.has(file.path)) continue;
    assertRuntimeFile(file.path, paths);
    if (file.existed) cpSync(join(runtimeBackupFiles(managedRoot), String(index)), file.path);
    else if (existsSync(file.path)) rmSync(file.path, { force: true });
  }
  for (const token of backup.mcpStopTokens ?? []) {
    if (/^[a-f0-9-]{36}$/i.test(token)) rmSync(join(config, "runtime-stop", `${token}.json`), { force: true });
  }
  if (backup.watcherPaused) {
    const stop = join(config, "watch", "stop.json");
    if (backup.watcherToken && readJson<{ token?: string }>(stop)?.token === backup.watcherToken) rmSync(stop, { force: true });
    if (backup.previousWatcher) restoreGlobalWatchRegistration(watchOptions, backup.previousWatcher);
  }
  finishRuntimeBackup(paths, backup);
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
  managedRoot: string,
  previousDirectory?: string
): { directory: string; cliPath: string; nodePath: string } {
  const releases = join(managedRoot, "releases");
  const original = join(releases, manifest.build.buildId);
  const reusable = [previousDirectory, original].find(path => path && containedBy(path, releases) && releaseMatches(path, manifest));
  const directory = reusable ?? (existsSync(original) ? join(releases, `${manifest.build.buildId}-${randomUUID()}`) : original);
  const engine = join(directory, "engine");
  const nodePath = join(engine, process.platform === "win32" ? "node.exe" : "node");
  const cliPath = join(engine, "cli.mjs");

  if (reusable) return { directory, cliPath, nodePath };
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
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { directory, cliPath, nodePath };
}

function releaseMatches(directory: string, manifest: DesktopEngineManifest): boolean {
  try {
    const engine = join(directory, "engine");
    return readManifest(join(engine, "manifest.json")).build.buildId === manifest.build.buildId
      && digest(join(engine, process.platform === "win32" ? "node.exe" : "node")) === manifest.nodeSha256
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

function inspectWatchRegistration(config: string, roots: string[]): GlobalWatchRegistration {
  try {
    const registration = readGlobalWatchRegistration({ cwd: config, global: true });
    const managed = (node: string, cli: string) => roots.some(root => containedBy(node, root) && containedBy(cli, root));
    if (process.platform === "darwin" && (registration.files.length || registration.loaded)) {
      const path = registration.files[0]?.path;
      if (!path) throw new Error("launchd reports a loaded job without its installation file.");
      const args = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path],
        { encoding: "utf8", timeout: 5000 })) as string[];
      if (!managed(args[0]!, args[1]!) || args[2] !== "watch" || !args.includes("--global")) {
        throw new Error("The launchd job points outside the managed runtime or uses unexpected arguments.");
      }
    }
    if (process.platform === "win32" && (registration.files.length || registration.tasks.length)) {
      const launcher = join(config, "watch", "code-butler-watch-global.ps1");
      const script = registration.files.find(file => file.path === launcher);
      const command = script && /^& '((?:[^']|'')+)' '((?:[^']|'')+)' 'watch' '--global'/m.exec(Buffer.from(script.content, "base64").toString("utf8"));
      if (!command || !managed(command[1]!.replaceAll("''", "'"), command[2]!.replaceAll("''", "'"))) {
        throw new Error("The scheduled watcher launcher does not point to a managed Code Butler runtime.");
      }
      const launcherPath = launcher.toLowerCase();
      if (registration.tasks.some(task => !task.xml.toLowerCase().replaceAll("&amp;", "&").includes(launcherPath)) ||
          registration.files.some(file => file !== script && !Buffer.from(file.content, "base64").toString("utf8").toLowerCase().includes(launcherPath))) {
        throw new Error("The scheduled watcher action does not match the installed launcher.");
      }
    }
    return registration;
  } catch (error) {
    throw new ManagedRuntimeBlockerError(`Could not verify the installed Code Butler watcher service. ${error instanceof Error ? error.message : "Its registration is unavailable."}`);
  }
}

function stopGlobalWatcher(configDirectory: string, roots: string[], verified: Map<number, string | undefined>,
  deadline: number, idleOnly: boolean): void {
  const options = { cwd: configDirectory, global: true } as const;
  const runnerPath = join(configDirectory, "watch", "runner.json");
  const runner = readJson<RuntimeRecord>(runnerPath);
  const state = runner ? managedWatcherState(runner, roots) : "stale";
  if (runner && (state === "unverified" || (state === "managed" &&
      (idleOnly || !sameProcessBirth(verified.get(runner.pid), runner.processStart))))) {
    throw new ManagedRuntimeBlockerError("The running watcher could not be verified for this setup attempt.");
  }
  const service = getWatchServiceStatus(options);
  pauseGlobalWatchService(options, state === "managed" && runner?.token ? runner.token : null);
  if (runner && state === "managed") waitForWatcherExit(runner, roots, deadline);

  // The verified launchd job can respawn after a cooperative stop. Unload it
  // without taking the watcher lock, then let any verified replacement exit.
  const latest = readJson<RuntimeRecord>(runnerPath);
  if (latest && latest.token !== runner?.token) {
    const latestState = managedWatcherState(latest, roots);
    if (latestState === "unverified" || (latestState === "managed" && (idleOnly || !service.installed))) {
      throw new ManagedRuntimeBlockerError("A new watcher started during shared runtime setup.");
    }
  }
  if (service.installed) {
    inspectWatchRegistration(configDirectory, roots);
    uninstallWatchService({ ...options, requireUnloaded: true });
  }
  if (latest && latest.token !== runner?.token) waitForWatcherExit(latest, roots, deadline);
}

function waitForWatcherExit(runner: RuntimeRecord, roots: string[], deadline: number): void {
  let state = managedWatcherState(runner, roots);
  while (state === "managed" && Date.now() < deadline) {
    sleep(250);
    state = managedWatcherState(runner, roots);
  }
  if (state !== "stale") throw new ManagedRuntimeBlockerError(`Watcher PID ${runner.pid} is still active or could not be verified.`);
}

export function managedWatcherState(runner: RuntimeRecord, roots: string[]): "stale" | "managed" | "unverified" {
  if (!Number.isSafeInteger(runner.pid) || runner.pid <= 0 || !isPidPresent(runner.pid)) return "stale";
  try { return inspectWatcher(runner, roots, managedProcessInventory(roots, [runner])).state; }
  catch { return "unverified"; }
}

function matchesRecord(process: ManagedProcess, record: RuntimeRecord): boolean {
  return sameProcessBirth(process.processStart, record.processStart) &&
    process.executable.toLowerCase() === record.executable?.toLowerCase() &&
    !!record.entrypoint && process.commandLine.toLowerCase().includes(record.entrypoint.toLowerCase());
}

function inspectWatcher(runner: RuntimeRecord, roots: string[], inventory: ManagedProcess[]): { state: "stale" | "managed" | "unverified"; reason?: string } {
  if (!Number.isSafeInteger(runner.pid) || runner.pid <= 0 || !isPidPresent(runner.pid)) return { state: "stale" };
  const current = inventory.find(process => process.pid === runner.pid);
  const currentBirth = current?.processStart ?? processStartIdentity(runner.pid);
  if (currentBirth && runner.processStart && !sameProcessBirth(currentBirth, runner.processStart)) return { state: "stale" };
  const unverified = (detail: string) => ({ state: "unverified" as const,
    reason: `Watcher PID ${runner.pid}: ${detail}. Close the watcher and retry.` });
  if (!runner.processStart) return unverified("the saved registration has no process start time");
  if (!currentBirth) return unverified("the process start time could not be read");
  if (runner.role !== "watcher" || !roots.some(root => containedBy(runner.executable, root) && containedBy(runner.entrypoint, root))) {
    return unverified("the saved executable or entrypoint is outside the managed runtime");
  }
  if (!current) return unverified("the executable path or command line could not be read or is outside the managed runtime");
  if (!matchesRecord(current, runner) || !/\bcli\.(?:mjs|js)["']?\s+watch\s+--global\b/i.test(current.commandLine)) {
    return unverified("the running executable or command line does not match the watcher registration");
  }
  return { state: "managed" };
}

interface ManagedProcess { pid: number; processStart?: string; executable: string; commandLine: string }
function managedProcessInventory(roots: string[], records = readRuntimeRecords()): ManagedProcess[] {
  if (process.platform !== "win32") return records.flatMap(record => {
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
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;processStart=$_.CreationDate.ToUniversalTime().Ticks.ToString();executable=$_.ExecutablePath;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress";
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
export function handleWatchGateBlocker(config: string, roots: string[]): void {
  const status = readProjectOperationStatus(join(config, "watch"));
  if (!status || !isPidPresent(status.pid)) return;
  const currentBirth = processStartIdentity(status.pid);
  const managed = managedProcessInventory(roots).some(process => process.pid === status.pid &&
    sameProcessBirth(process.processStart, currentBirth) &&
    /\bcli\.(?:mjs|js)["']?\s+watch\s+--global\b/i.test(process.commandLine));
  if (!managed) throw new ManagedRuntimeBlockerError(`The watcher operation lock belongs to PID ${status.pid}, which could not be verified. Close the process holding the lock and retry.`);
  throw new ManagedRuntimeBlockerError(`The watcher operation lock still belongs to Butler PID ${status.pid}. Wait for it to finish and retry.`);
}
function unverifiedMcpProcess(records: RuntimeRecord[], roots: string[], inventory: ManagedProcess[]): string | undefined {
  for (const record of records) {
    if (record.role !== "mcp" || !roots.some(root => containedBy(record.executable, root) || containedBy(record.entrypoint, root))) continue;
    const current = inventory.find(process => process.pid === record.pid);
    if (current && matchesRecord(current, record) && /\bcli\.(?:mjs|js)["']?\s+mcp\b/i.test(current.commandLine)) continue;
    if (!isPidPresent(record.pid)) continue;
    const birth = current?.processStart ?? processStartIdentity(record.pid);
    if (birth && record.processStart && !sameProcessBirth(birth, record.processStart)) continue;
    return `Butler MCP PID ${record.pid} could not be verified. Quit the coding tool using it and retry.`;
  }
  return undefined;
}

function runtimeCandidates(records: RuntimeRecord[], roots: string[], inventory: ManagedProcess[]): RuntimeRecord[] {
  const known = records.filter(record => record.pid !== process.pid && record.role === "mcp" &&
    roots.some(root => containedBy(record.entrypoint, root) && containedBy(record.executable, root)) &&
    inventory.some(process => process.pid === record.pid && matchesRecord(process, record) && /\bcli\.(?:mjs|js)["']?\s+mcp\b/i.test(process.commandLine)));
  const discovered: RuntimeRecord[] = process.platform !== "win32" ? [] : inventory.flatMap(candidate => {
    if (candidate.pid === process.pid || records.some(record => record.pid === candidate.pid)) return [];
    const match = /^(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s+(mcp\b|watch\s+--global\b)/i.exec(candidate.commandLine);
    const entrypoint = match?.[3] ?? match?.[4];
    const node = match?.[1] ?? match?.[2];
    if (!entrypoint || node?.toLowerCase() !== candidate.executable.toLowerCase() ||
        !roots.some(root => containedBy(entrypoint, root)) || !/\bcli\.(?:mjs|js)$/i.test(entrypoint)) return [];
    return [{ pid: candidate.pid, ...(candidate.processStart ? { processStart: candidate.processStart } : {}),
      executable: candidate.executable, entrypoint, token: "", startedAt: "", role: match?.[5]?.toLowerCase() === "mcp" ? "mcp" : "watcher",
      build: { version: "unknown", buildId: "unknown", builtAt: "unknown" } }];
  });
  return [...known, ...discovered];
}

function inspectManagedConnections(config: string, roots: string[]): RuntimeRecord[] {
  const records = readRuntimeRecords(config);
  let inventory: ManagedProcess[];
  try { inventory = managedProcessInventory(roots, records); }
  catch { throw new ManagedRuntimeBlockerError("The active Butler connections could not be inspected."); }
  const unverified = unverifiedMcpProcess(records, roots, inventory);
  if (unverified) throw new ManagedRuntimeBlockerError(unverified);
  return runtimeCandidates(records, roots, inventory);
}

function waitForManagedConnections(candidates: RuntimeRecord[], roots: string[], config: string, deadline: number): number {
  const stillRunning = (record: RuntimeRecord) => {
    if (!isPidPresent(record.pid)) return false;
    const birth = processStartIdentity(record.pid);
    return !birth || sameProcessBirth(birth, record.processStart);
  };
  while (candidates.some(stillRunning) && Date.now() < deadline) sleep(250);
  if (candidates.some(stillRunning) || inspectManagedConnections(config, roots).length) {
    throw new ManagedRuntimeBlockerError("A Butler connection is still active.");
  }
  return candidates.filter(record => record.role === "mcp").length;
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
function waitForWatcherBuild(config: string, roots: string[], buildId: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  do {
    const runner = readJson<RuntimeRecord>(join(config, "watch", "runner.json"));
    if (runner?.build?.buildId === buildId && isPidPresent(runner.pid) &&
      managedWatcherState(runner, roots) === "managed") return;
    sleep(500);
  } while (Date.now() < deadline);
  handleWatchGateBlocker(config, roots);
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
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function containedBy(path: string, root: string): boolean {
  if (typeof path !== "string" || !path) return false;
  const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const candidate = comparable(normalize(resolve(path)));
  const parent = comparable(normalize(resolve(root)));
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

async function runInstaller(args: string[]): Promise<void> {
  const [mode, argument, buildId] = args;
  if (mode === "--probe" && argument && buildId && args.length === 3) {
    const launcher = process.platform === "win32"
      ? { command: join(argument, "node.exe"), args: [join(argument, "node_modules", "code-butler", "dist", "cli.js")] }
      : { command: join(argument, "code-butler"), args: [] };
    const version = JSON.parse(execFileSync(launcher.command, [...launcher.args, "--version"],
      { timeout: 5000, encoding: "utf8", windowsHide: true })) as BuildInfo;
    if (version.buildId !== buildId) throw new Error("The CLI launcher did not select the installed build.");
    const marker = readJson<{ token: string }>(join(globalConfigDir(), "watch", "runtime-activation.json"));
    process.env.CODE_BUTLER_UPGRADE_PROBE = marker?.token ?? "";
    delete process.env.CODE_BUTLER_PROJECT_ROOT;
    const result = await probeMcpLauncher({ ...launcher, args: [...launcher.args, "mcp", "--no-auto-init"] });
    if (!result.ok) throw new Error(`The updated MCP launcher failed its check. ${result.detail}`);
    return;
  }
  if (mode === "--preflight" && args.length === 1) {
    console.log(JSON.stringify(preflightDesktopRuntime()));
    return;
  }
  if (mode === "--upgrade-notice" && args.length === 1) {
    console.log(JSON.stringify(desktopRuntimeNotice() ?? null));
    return;
  }
  if (process.platform === "darwin" && process.getuid?.() === 0) throw new Error("Run runtime setup as the signed-in user.");
  if (!args.length || (args.length === 1 && (mode === "--reconcile" || mode === "--install-if-idle"))) {
    console.log(JSON.stringify(installDesktopRuntime({ idleOnly: mode === "--install-if-idle" })));
    return;
  }
  throw new Error("Unknown shared runtime setup option.");
}

if (isDesktopRuntimeInstallerEntrypoint(import.meta.url, process.argv[1])) {
  void runInstaller(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "Code Butler runtime installation failed");
    process.exitCode = error instanceof ManagedRuntimeBlockerError ? error.exitCode : error instanceof OperationDeferredError ? 20 : 1;
  });
}
