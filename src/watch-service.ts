import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SyncSourceName } from "./types.js";
import { globalConfigDir } from "./config.js";
import { atomicJson } from "./cloud/state.js";
import { requestGlobalWatchStop } from "./global-watch.js";
import { storeLauncher, storeStartup } from "./store-runtime.js";

export type WatchSource = SyncSourceName | "all";
export type WatchServiceCommandRunner = (command: string, args: string[]) => void;

export interface WatchServiceOptions {
  cwd: string;
  global?: boolean;
  homeDir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  intervalSeconds?: number | undefined;
  source?: WatchSource | undefined;
  cliPath?: string | undefined;
  nodePath?: string | undefined;
  commandRunner?: WatchServiceCommandRunner | undefined;
  runCommands?: boolean | undefined;
  requireUnloaded?: boolean | undefined;
}

export interface WatchServiceResult {
  platform: NodeJS.Platform;
  label: string;
  servicePath?: string | undefined;
  unitName?: string | undefined;
  taskName?: string | undefined;
  logsDir: string;
  installed: boolean;
}

interface ResolvedWatchService {
  global: boolean;
  cwd: string;
  homeDir: string;
  platform: NodeJS.Platform;
  intervalSeconds: number;
  source: WatchSource;
  cliPath: string;
  nodePath: string;
  hash: string;
  label: string;
  logsDir: string;
  runner: WatchServiceCommandRunner;
  runCommands: boolean;
  requireUnloaded: boolean;
}

export function installWatchService(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);
  mkdirSync(service.logsDir, { recursive: true });

  if (service.global && storeLauncher(service.platform)) {
    const status = storeStartup("enable");
    return { platform: service.platform, label: service.label, taskName: "CodeButlerWatcher", logsDir: service.logsDir, installed: status.installed };
  }

  if (service.platform === "darwin") return installLaunchdService(service);
  if (service.platform === "linux") return installSystemdService(service);
  if (service.platform === "win32") return installScheduledTask(service);

  throw new Error(`background watcher install is not supported on ${service.platform}`);
}

export function uninstallWatchService(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);

  if (service.global && storeLauncher(service.platform)) {
    storeStartup("disable");
    requestGlobalWatchStop();
    return { platform: service.platform, label: service.label, taskName: "CodeButlerWatcher", logsDir: service.logsDir, installed: false };
  }

  if (service.platform === "darwin") return uninstallLaunchdService(service);
  if (service.platform === "linux") return uninstallSystemdService(service);
  if (service.platform === "win32") return uninstallScheduledTask(service);

  throw new Error(`background watcher uninstall is not supported on ${service.platform}`);
}

/** Prevent a scheduled restart, then ask the running global watcher to drain. */
export function pauseGlobalWatchService(options: WatchServiceOptions, approvedToken?: string | null): void {
  const service = resolveWatchService({ ...options, global: true });
  if (service.platform === "win32") {
    if (service.runCommands) for (const name of scheduledTaskNames(service))
      runIgnoringFailure(service, "schtasks.exe", ["/Change", "/TN", name, "/DISABLE"]);
  }
  if (approvedToken) atomicJson(join(service.cwd, "watch", "stop.json"), { token: approvedToken });
  else if (approvedToken === undefined) requestGlobalWatchStop();
}
export function resumeGlobalWatchService(options: WatchServiceOptions): void {
  const service = resolveWatchService({ ...options, global: true });
  if (service.platform === "win32" && service.runCommands) for (const name of scheduledTaskNames(service))
    runIgnoringFailure(service, "schtasks.exe", ["/Change", "/TN", name, "/ENABLE"]);
}

export interface GlobalWatchRegistration {
  files: Array<{ path: string; content: string }>;
  tasks: Array<{ name: string; xml: string; enabled: boolean }>;
  loaded: boolean;
}

interface WindowsWatcherTask {
  name: string;
  enabled: boolean;
  sameUser: boolean;
  actions: { execute?: string; arguments?: string; workingDirectory?: string }[];
}

export interface WindowsWatcherRegistration {
  tasks: { name: string; enabled: boolean }[];
  startup?: string;
  launcher: string;
  launcherInactive?: boolean;
  nodePath: string;
  cliPath: string;
}

const startupFirstLine = 'Set shell = CreateObject("WScript.Shell")';
const startupExit = "WScript.Quit 0";
const launcherExit = "exit 0";
const windowsGlobalOptions = () => resolveWatchService({ cwd: globalConfigDir(), global: true });

function windowsGlobalTasks(service: ResolvedWatchService): WindowsWatcherTask[] {
  const script = String.raw`$ErrorActionPreference='Stop'
    [Console]::OutputEncoding=[Text.Encoding]::UTF8
    $current=[Security.Principal.WindowsIdentity]::GetCurrent()
    $tasks=@(Get-ScheduledTask | Where-Object {
      ($_.TaskPath + $_.TaskName) -in @('\CodeButler-watch-global','\CodeButler\watch-global')
    } | ForEach-Object {
      $user=$_.Principal.UserId
      $sameUser=$user -eq $current.Name -or $user -eq $current.User.Value
      if ($user -and !$sameUser) {
        try { $sameUser=([Security.Principal.NTAccount]$user).Translate([Security.Principal.SecurityIdentifier]).Value -eq $current.User.Value } catch {}
      }
      @{name=$_.TaskPath + $_.TaskName;enabled=$_.Settings.Enabled;sameUser=$sameUser;actions=@($_.Actions | ForEach-Object {
        @{execute=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory}
      })}
    })
    ConvertTo-Json -InputObject $tasks -Depth 5 -Compress`;
  const tasks = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 10_000
  })) as WindowsWatcherTask[];
  const argumentsExpected = windowsTaskCommand(service).slice("powershell.exe ".length);
  return tasks.map(task => {
    const name = task.name.toLowerCase();
    const action = task.actions[0];
    if (!scheduledTaskNames(service).some(expected => expected.toLowerCase() === name || `\\${expected.toLowerCase()}` === name) ||
        !task.sameUser || task.actions.length !== 1 || action?.execute?.toLowerCase() !== "powershell.exe" ||
        action.arguments?.toLowerCase() !== argumentsExpected.toLowerCase() || action.workingDirectory ||
        typeof task.enabled !== "boolean") throw new Error("The existing Windows watcher task could not be verified.");
    return { ...task, name };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function readStartupFile(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error("The Windows watcher startup file is not a regular file.");
    return readFileSync(path).toString("base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function windowsGlobalStartupScript(service: ResolvedWatchService): string {
  return `${startupFirstLine}\r\nshell.Run "${windowsTaskCommand(service).replaceAll('"', '""')}", 0, False\r\n`;
}

function matchesWindowsScript(script: string, expected: string, firstLine: string, exit: string): boolean {
  const actual = Buffer.from(script);
  const original = Buffer.from(expected);
  const headerLength = Buffer.byteLength(firstLine);
  const parked = Buffer.from(exit.padEnd(headerLength));
  // A crash during the fixed-width write can leave some of the original bytes.
  return actual.subarray(headerLength).equals(original.subarray(headerLength)) &&
    actual.subarray(0, headerLength).every((value, index) => value === original[index] || value === parked[index]);
}

function setWindowsScriptParked(path: string, original: string, firstLine: string, exit: string, parked: boolean): void {
  const before = readStartupFile(path);
  if (before === undefined || !matchesWindowsScript(Buffer.from(before, "base64").toString("utf8"), original, firstLine, exit)) {
    throw new Error("The standalone watcher startup script changed during the handoff.");
  }
  // Preserve the original byte count, including paths that contain non-ASCII characters.
  const firstLineBytes = Buffer.byteLength(firstLine);
  const after = Buffer.from(parked ? exit.padEnd(firstLineBytes) : firstLine);
  if (!Buffer.from(before, "base64").subarray(0, after.length).equals(after)) {
    // Opening the existing file avoids redirecting a new file into the MSIX's AppData.
    const fd = openSync(path, "r+");
    try {
      if (!fstatSync(fd).isFile() || readFileSync(fd).toString("base64") !== before) throw new Error("The startup script changed during the handoff.");
      if (writeSync(fd, after, 0, after.length, 0) !== after.length) throw new Error("Could not write the complete startup script.");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  const expected = Buffer.concat([after, Buffer.from(original.slice(firstLine.length))]).toString("base64");
  if (readStartupFile(path) !== expected) throw new Error("Could not verify the new state of the startup script.");
}

export function readWindowsWatcherRegistration(): WindowsWatcherRegistration | undefined {
  const service = windowsGlobalOptions();
  const tasks = windowsGlobalTasks(service).map(({ name, enabled }) => ({ name, enabled }));
  const startup = readStartupFile(windowsStartupPath(service));
  const startupText = startup === undefined ? undefined : Buffer.from(startup, "base64").toString("utf8");
  const expected = windowsGlobalStartupScript(service);
  if (startupText !== undefined && !matchesWindowsScript(startupText, expected, startupFirstLine, startupExit)) {
    throw new Error("The existing Windows watcher Startup-folder entry could not be verified.");
  }
  if (!tasks.length && startupText !== expected) return undefined;
  const launcher = readStartupFile(windowsLauncherPath(service));
  if (!launcher) throw new Error("The standalone watcher launcher is missing.");
  const actualLauncher = Buffer.from(launcher, "base64").toString("utf8");
  const firstLine = windowsLauncherHeader(service);
  const firstLineEnd = actualLauncher.indexOf("\r\n");
  const launcherText = firstLine + actualLauncher.slice(firstLineEnd);
  if (firstLineEnd < 0 || !matchesWindowsScript(actualLauncher, launcherText, firstLine, launcherExit)) {
    throw new Error("The standalone watcher launcher could not be verified.");
  }
  const command = /^& '((?:[^']|'')+)' '((?:[^']|'')+)' 'watch' '--global' '--interval' '([0-9.e+-]+)' '--source' '([a-z-]+)' >> /m.exec(launcherText);
  if (!command) throw new Error("The standalone watcher launcher could not be verified.");
  const [, node, cli, interval, source] = command;
  const nodePath = node!.replaceAll("''", "'");
  const cliPath = cli!.replaceAll("''", "'");
  if (launcherText !== windowsLauncher({ ...service, nodePath, cliPath, intervalSeconds: Number(interval), source: source as WatchSource })) {
    throw new Error("The standalone watcher launcher contains unexpected commands.");
  }
  return {
    tasks, ...(startupText === expected && startup !== undefined ? { startup } : {}),
    launcher: Buffer.from(launcherText).toString("base64"), launcherInactive: actualLauncher !== launcherText, nodePath, cliPath
  };
}

export function changeWindowsWatcherRegistration(registration: WindowsWatcherRegistration, enable: boolean): void {
  const service = windowsGlobalOptions();
  const current = readWindowsWatcherRegistration();
  if (!current || registration.launcher !== current.launcher ||
      JSON.stringify(registration.tasks.map(task => task.name)) !== JSON.stringify(current.tasks.map(task => task.name))) {
    // A Startup-only registration intentionally has no active entry while it is paused.
    const parked = !registration.tasks.length && !current &&
      readStartupFile(windowsLauncherPath(service)) === registration.launcher;
    if (!parked) throw new Error("The standalone watcher registration changed during the handoff.");
  }
  if (current?.startup && current.startup !== registration.startup) {
    throw new Error("The Startup-folder entry changed during the handoff.");
  }
  let parkLauncher = false;
  for (const task of registration.tasks) {
    const before = current?.tasks.find(candidate => candidate.name === task.name)?.enabled;
    const after = enable && task.enabled;
    if (before === after) continue;
    try { run(service, "schtasks.exe", ["/Change", "/TN", task.name, after ? "/ENABLE" : "/DISABLE"]); }
    catch (error) {
      if (enable) throw error;
      // An elevated standalone installation can leave its verified task read-only.
      // Both startup paths use the same per-user launcher, so retire that launcher.
      parkLauncher = true;
    }
  }
  if (parkLauncher || current?.launcherInactive) {
    setWindowsScriptParked(windowsLauncherPath(service), Buffer.from(registration.launcher, "base64").toString("utf8"),
      windowsLauncherHeader(service), launcherExit, parkLauncher);
  }
  if (registration.startup && !parkLauncher) {
    const original = Buffer.from(registration.startup, "base64").toString("utf8");
    if (original !== windowsGlobalStartupScript(service)) throw new Error("Invalid saved Startup-folder entry.");
    setWindowsScriptParked(windowsStartupPath(service), original, startupFirstLine, startupExit, !enable);
  }
  const after = readWindowsWatcherRegistration();
  const tasksMatch = parkLauncher
    ? JSON.stringify(after?.tasks.map(task => task.name)) === JSON.stringify(registration.tasks.map(task => task.name))
    : JSON.stringify(after?.tasks ?? []) === JSON.stringify(registration.tasks.map(task => ({ ...task, enabled: enable && task.enabled })));
  if (!tasksMatch || Boolean(after?.launcherInactive) !== parkLauncher ||
      after?.startup !== (enable || parkLauncher ? registration.startup : undefined)) {
    throw new Error("Could not verify the new state of the standalone watcher startup entries.");
  }
}

export function restartWindowsWatcherRegistration(registration: WindowsWatcherRegistration): void {
  const service = windowsGlobalOptions();
  const task = registration.tasks.find(task => task.enabled);
  if (task) run(service, "schtasks.exe", ["/Run", "/TN", task.name]);
  else if (registration.startup) run(service, "wscript.exe", ["//B", windowsStartupPath(service)]);
}

/** Capture the actual registration, including legacy task names and disabled tasks. */
export function readGlobalWatchRegistration(options: WatchServiceOptions): GlobalWatchRegistration {
  const service = resolveWatchService({ ...options, global: true });
  const result: GlobalWatchRegistration = { files: [], tasks: [], loaded: false };
  const remember = (path: string) => {
    if (existsSync(path)) result.files.push({ path, content: readFileSync(path).toString("base64") });
  };
  if (service.platform === "darwin") {
    remember(launchdPlistPath(service));
    result.loaded = service.runCommands && commandSucceeds(service, "launchctl", ["print", `${launchdDomain()}/${service.label}`]);
  } else if (service.platform === "win32") {
    remember(windowsLauncherPath(service));
    remember(windowsStartupPath(service));
    if (service.runCommands) for (const name of scheduledTaskNames(service)) {
      if (!commandSucceeds(service, "schtasks.exe", ["/Query", "/TN", name])) continue;
      const raw = execFileSync("schtasks.exe", ["/Query", "/TN", name, "/XML"], {
        windowsHide: true, timeout: 5000
      });
      const xml = raw.includes(0) ? raw.toString("utf16le") : raw.toString("utf8");
      result.tasks.push({ name, xml: xml.replace(/^\uFEFF/, ""), enabled: !/<Enabled>\s*false\s*<\/Enabled>/i.test(xml) });
    }
  }
  return result;
}

export function restoreGlobalWatchRegistration(options: WatchServiceOptions, registration: GlobalWatchRegistration): void {
  const service = resolveWatchService({ ...options, global: true });
  const locations = service.platform === "darwin" ? [launchdPlistPath(service)] : [windowsLauncherPath(service), windowsStartupPath(service)];
  for (const file of registration.files) {
    if (!locations.includes(file.path)) throw new Error("The saved watcher registration has an unexpected path.");
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, Buffer.from(file.content, "base64"));
  }
  if (!service.runCommands) return;
  if (service.platform === "darwin" && registration.loaded) {
    const label = `${launchdDomain()}/${service.label}`;
    if (!commandSucceeds(service, "launchctl", ["print", label])) {
      run(service, "launchctl", ["bootstrap", launchdDomain(), launchdPlistPath(service)]);
    }
    runIgnoringFailure(service, "launchctl", ["kickstart", label]);
  } else if (service.platform === "win32") {
    const xmlFile = join(service.cwd, "watch", "restore-task.xml");
    for (const task of registration.tasks) {
      if (!scheduledTaskNames(service).includes(task.name)) throw new Error("The saved watcher task has an unexpected name.");
      mkdirSync(dirname(xmlFile), { recursive: true });
      try {
        writeFileSync(xmlFile, Buffer.from(`\uFEFF${task.xml.replace(/encoding="[^"]+"/i, 'encoding="UTF-16"')}`, "utf16le"));
        run(service, "schtasks.exe", ["/Create", "/TN", task.name, "/XML", xmlFile, "/F"]);
      } finally { rmSync(xmlFile, { force: true }); }
      if (task.enabled) runIgnoringFailure(service, "schtasks.exe", ["/Run", "/TN", task.name]);
    }
    const startup = windowsStartupPath(service);
    if (existsSync(startup)) run(service, "wscript.exe", ["//B", startup]);
  }
}

export function getWatchServiceStatus(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);
  if (service.global && storeLauncher(service.platform)) {
    const status = storeStartup("status");
    return { platform: service.platform, label: service.label, taskName: "CodeButlerWatcher", logsDir: service.logsDir, installed: status.installed };
  }

  if (service.platform === "darwin") {
    const servicePath = launchdPlistPath(service);
    return { platform: service.platform, label: service.label, servicePath, logsDir: service.logsDir, installed: existsSync(servicePath) };
  }

  if (service.platform === "linux") {
    const { unitName, servicePath } = systemdUnit(service);
    return { platform: service.platform, label: service.label, unitName, servicePath, logsDir: service.logsDir, installed: existsSync(servicePath) };
  }

  if (service.platform === "win32") {
    if (service.global && existsSync(windowsStartupPath(service))) {
      return { platform: service.platform, label: service.label, servicePath: windowsStartupPath(service), logsDir: service.logsDir, installed: true };
    }
    let taskName = scheduledTaskName(service);
    let installed = false;
    if (service.runCommands) {
      for (const name of scheduledTaskNames(service)) {
        if (commandSucceeds(service, "schtasks.exe", ["/Query", "/TN", name])) {
          taskName = name;
          installed = true;
          break;
        }
      }
    }
    return { platform: service.platform, label: service.label, taskName, logsDir: service.logsDir, installed };
  }

  throw new Error(`background watcher status is not supported on ${service.platform}`);
}

function resolveWatchService(options: WatchServiceOptions): ResolvedWatchService {
  const cwd = options.global ? globalConfigDir() : options.cwd;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const intervalSeconds = options.intervalSeconds ?? 30;
  const source = options.source ?? "all";
  const cliPath = options.cliPath ?? process.argv[1] ?? join(cwd, "dist", "cli.js");
  const nodePath = options.nodePath ?? process.execPath;
  const hash = options.global ? "global" : createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const label = `com.codebutler.watch.${hash}`;
  const logsDir = options.global ? join(cwd, "watch", "logs") : join(cwd, ".code-butler", "logs");
  const runner = options.commandRunner ?? defaultCommandRunner;
  const runCommands = options.runCommands ?? true;

  return { global: options.global ?? false, cwd, homeDir, platform, intervalSeconds, source, cliPath, nodePath, hash, label, logsDir, runner, runCommands,
    requireUnloaded: options.requireUnloaded ?? false };
}

function installLaunchdService(service: ResolvedWatchService): WatchServiceResult {
  const servicePath = launchdPlistPath(service);
  mkdirSync(join(service.homeDir, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(servicePath, launchdPlist(service));

  if (service.runCommands) {
    try {
      run(service, "launchctl", ["bootstrap", launchdDomain(), servicePath]);
    } catch {
      runIgnoringFailure(service, "launchctl", ["bootout", launchdDomain(), servicePath]);
      run(service, "launchctl", ["bootstrap", launchdDomain(), servicePath]);
    }
  }

  return { platform: service.platform, label: service.label, servicePath, logsDir: service.logsDir, installed: true };
}

function uninstallLaunchdService(service: ResolvedWatchService): WatchServiceResult {
  const servicePath = launchdPlistPath(service);
  if (service.runCommands) {
    runIgnoringFailure(service, "launchctl", ["bootout", launchdDomain(), servicePath]);
    if (service.requireUnloaded && commandSucceeds(service, "launchctl", ["print", `${launchdDomain()}/${service.label}`])) {
      throw new Error("The Code Butler watcher is still loaded in launchd.");
    }
  }
  rmSync(servicePath, { force: true });
  return { platform: service.platform, label: service.label, servicePath, logsDir: service.logsDir, installed: false };
}

function installSystemdService(service: ResolvedWatchService): WatchServiceResult {
  const { unitName, servicePath } = systemdUnit(service);
  mkdirSync(join(service.homeDir, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(servicePath, systemdService(service));

  if (service.runCommands) {
    run(service, "systemctl", ["--user", "daemon-reload"]);
    run(service, "systemctl", ["--user", "enable", "--now", unitName]);
  }

  return { platform: service.platform, label: service.label, unitName, servicePath, logsDir: service.logsDir, installed: true };
}

function uninstallSystemdService(service: ResolvedWatchService): WatchServiceResult {
  const { unitName, servicePath } = systemdUnit(service);
  if (service.runCommands) {
    runIgnoringFailure(service, "systemctl", ["--user", "disable", "--now", unitName]);
  }
  rmSync(servicePath, { force: true });
  if (service.runCommands) runIgnoringFailure(service, "systemctl", ["--user", "daemon-reload"]);
  return { platform: service.platform, label: service.label, unitName, servicePath, logsDir: service.logsDir, installed: false };
}

function installScheduledTask(service: ResolvedWatchService): WatchServiceResult {
  const taskName = scheduledTaskName(service);
  const taskCommand = windowsTaskCommand(service);
  writeFileSync(windowsLauncherPath(service), windowsLauncher(service));

  if (service.runCommands) {
    try {
      run(service, "schtasks.exe", ["/Create", "/TN", taskName, "/TR", taskCommand, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
      if (service.global) {
        run(service, "powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
          "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Set-ScheduledTask -TaskName 'CodeButler-watch-global' -Settings $settings | Out-Null"]);
      }
      run(service, "schtasks.exe", ["/Run", "/TN", taskName]);
      if (service.global) rmSync(windowsStartupPath(service), { force: true });
    } catch (error) {
      if (!service.global) throw error;
      // Standard Windows accounts can be denied Task Scheduler creation.
      runIgnoringFailure(service, "schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
      const startupPath = windowsStartupPath(service);
      mkdirSync(dirname(startupPath), { recursive: true });
      writeFileSync(startupPath, windowsGlobalStartupScript(service));
      run(service, "wscript.exe", ["//B", startupPath]);
      return { platform: service.platform, label: service.label, servicePath: startupPath, logsDir: service.logsDir, installed: true };
    }
  }

  return { platform: service.platform, label: service.label, taskName, logsDir: service.logsDir, installed: true };
}

function uninstallScheduledTask(service: ResolvedWatchService): WatchServiceResult {
  const taskName = scheduledTaskName(service);
  if (service.global) {
    requestGlobalWatchStop();
    rmSync(windowsStartupPath(service), { force: true });
  }
  if (service.runCommands) {
    for (const name of scheduledTaskNames(service)) {
      runIgnoringFailure(service, "schtasks.exe", ["/End", "/TN", name]);
      runIgnoringFailure(service, "schtasks.exe", ["/Delete", "/TN", name, "/F"]);
      if (service.requireUnloaded && commandSucceeds(service, "schtasks.exe", ["/Query", "/TN", name])) {
        throw new Error(`The Code Butler watcher task ${name} is still registered.`);
      }
    }
  }
  rmSync(windowsLauncherPath(service), { force: true });
  return { platform: service.platform, label: service.label, taskName, logsDir: service.logsDir, installed: false };
}

function launchdPlistPath(service: ResolvedWatchService): string {
  return join(service.homeDir, "Library", "LaunchAgents", `${service.label}.plist`);
}

function launchdPlist(service: ResolvedWatchService): string {
  const args = watchArgs(service);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...(service.global ? ["  <key>EnvironmentVariables</key>", "  <dict>", "    <key>CODE_BUTLER_HOME</key>", `    <string>${xmlEscape(service.cwd)}</string>`, "  </dict>"] : []),
    "  <key>Label</key>",
    `  <string>${xmlEscape(service.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(service.cwd)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(join(service.logsDir, "watch.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(service.logsDir, "watch.err.log"))}</string>`,
    "</dict>",
    "</plist>"
  ].join("\n") + "\n";
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function systemdUnit(service: ResolvedWatchService): { unitName: string; servicePath: string } {
  const unitName = `code-butler-watch-${service.hash}.service`;
  return {
    unitName,
    servicePath: join(service.homeDir, ".config", "systemd", "user", unitName)
  };
}

function systemdService(service: ResolvedWatchService): string {
  return [
    "[Unit]",
    `Description=Code Butler watcher for ${service.cwd}`,
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    ...(service.global ? [`Environment=${systemdArg(`CODE_BUTLER_HOME=${service.cwd}`)}`] : []),
    `WorkingDirectory=${systemdArg(service.cwd)}`,
    `ExecStart=${watchArgs(service).map(systemdArg).join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${join(service.logsDir, "watch.out.log")}`,
    `StandardError=append:${join(service.logsDir, "watch.err.log")}`,
    "",
    "[Install]",
    "WantedBy=default.target"
  ].join("\n") + "\n";
}

function scheduledTaskName(service: ResolvedWatchService): string {
  return `CodeButler-watch-${service.hash}`;
}

function legacyScheduledTaskName(service: ResolvedWatchService): string {
  return `\\CodeButler\\watch-${service.hash}`;
}

function scheduledTaskNames(service: ResolvedWatchService): string[] {
  return [scheduledTaskName(service), legacyScheduledTaskName(service)];
}

function windowsTaskCommand(service: ResolvedWatchService): string {
  if (service.global) return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ${windowsArg(windowsLauncherPath(service))}`;
  return windowsArg(windowsLauncherPath(service));
}

function windowsStartupPath(service: ResolvedWatchService): string {
  const roaming = service.homeDir === homedir() ? process.env.APPDATA ?? join(service.homeDir, "AppData", "Roaming") : join(service.homeDir, "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodeButler-watch-global.vbs");
}

function windowsLauncherPath(service: ResolvedWatchService): string {
  if (service.global) return join(service.cwd, "watch", "code-butler-watch-global.ps1");
  return join(service.cwd, ".code-butler", `code-butler-watch-${service.hash}.cmd`);
}

function windowsLauncher(service: ResolvedWatchService): string {
  const outLog = join(service.logsDir, "watch.out.log");
  const errLog = join(service.logsDir, "watch.err.log");
  if (service.global) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return [
      windowsLauncherHeader(service),
      `Set-Location -LiteralPath ${quote(service.cwd)}`,
      `& ${watchArgs(service).map(quote).join(" ")} >> ${quote(outLog)} 2>> ${quote(errLog)}`,
      "exit $LASTEXITCODE"
    ].join("\r\n") + "\r\n";
  }
  return [
    "@echo off",
    `cd /d ${windowsCmdArg(service.cwd)}`,
    "if errorlevel 1 exit /b %errorlevel%",
    `${watchArgs(service).map(windowsCmdArg).join(" ")} >> ${windowsCmdArg(outLog)} 2>> ${windowsCmdArg(errLog)}`
  ].join("\r\n") + "\r\n";
}

function windowsLauncherHeader(service: ResolvedWatchService): string {
  return `$env:CODE_BUTLER_HOME = '${service.cwd.replaceAll("'", "''")}'`;
}

function watchArgs(service: ResolvedWatchService): string[] {
  return [service.nodePath, service.cliPath, "watch", ...(service.global ? ["--global"] : []), "--interval", String(service.intervalSeconds), "--source", service.source];
}

function run(service: ResolvedWatchService, command: string, args: string[]): void {
  service.runner(command, args);
}

function runIgnoringFailure(service: ResolvedWatchService, command: string, args: string[]): void {
  try {
    run(service, command, args);
  } catch {
    // The service may already be stopped or absent.
  }
}

function commandSucceeds(service: ResolvedWatchService, command: string, args: string[]): boolean {
  try {
    run(service, command, args);
    return true;
  } catch {
    return false;
  }
}

function defaultCommandRunner(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "ignore", windowsHide: true, timeout: 10_000 });
}

function systemdArg(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function windowsCmdArg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
