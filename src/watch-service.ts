import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SyncSourceName } from "./types.js";

export type WatchSource = SyncSourceName | "all";
export type WatchServiceCommandRunner = (command: string, args: string[]) => void;

export interface WatchServiceOptions {
  cwd: string;
  homeDir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  intervalSeconds?: number | undefined;
  source?: WatchSource | undefined;
  cliPath?: string | undefined;
  nodePath?: string | undefined;
  commandRunner?: WatchServiceCommandRunner | undefined;
  runCommands?: boolean | undefined;
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
}

export function installWatchService(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);
  mkdirSync(service.logsDir, { recursive: true });

  if (service.platform === "darwin") return installLaunchdService(service);
  if (service.platform === "linux") return installSystemdService(service);
  if (service.platform === "win32") return installScheduledTask(service);

  throw new Error(`background watcher install is not supported on ${service.platform}`);
}

export function uninstallWatchService(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);

  if (service.platform === "darwin") return uninstallLaunchdService(service);
  if (service.platform === "linux") return uninstallSystemdService(service);
  if (service.platform === "win32") return uninstallScheduledTask(service);

  throw new Error(`background watcher uninstall is not supported on ${service.platform}`);
}

export function getWatchServiceStatus(options: WatchServiceOptions): WatchServiceResult {
  const service = resolveWatchService(options);

  if (service.platform === "darwin") {
    const servicePath = launchdPlistPath(service);
    return { platform: service.platform, label: service.label, servicePath, logsDir: service.logsDir, installed: existsSync(servicePath) };
  }

  if (service.platform === "linux") {
    const { unitName, servicePath } = systemdUnit(service);
    return { platform: service.platform, label: service.label, unitName, servicePath, logsDir: service.logsDir, installed: existsSync(servicePath) };
  }

  if (service.platform === "win32") {
    const taskName = scheduledTaskName(service);
    const installed = service.runCommands ? commandSucceeds(service, "schtasks.exe", ["/Query", "/TN", taskName]) : false;
    return { platform: service.platform, label: service.label, taskName, logsDir: service.logsDir, installed };
  }

  throw new Error(`background watcher status is not supported on ${service.platform}`);
}

function resolveWatchService(options: WatchServiceOptions): ResolvedWatchService {
  const cwd = options.cwd;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const intervalSeconds = options.intervalSeconds ?? 30;
  const source = options.source ?? "all";
  const cliPath = options.cliPath ?? process.argv[1] ?? join(cwd, "dist", "cli.js");
  const nodePath = options.nodePath ?? process.execPath;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const label = `com.codebutler.watch.${hash}`;
  const logsDir = join(cwd, ".code-butler", "logs");
  const runner = options.commandRunner ?? defaultCommandRunner;
  const runCommands = options.runCommands ?? true;

  return { cwd, homeDir, platform, intervalSeconds, source, cliPath, nodePath, hash, label, logsDir, runner, runCommands };
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
  if (service.runCommands) runIgnoringFailure(service, "launchctl", ["bootout", launchdDomain(), servicePath]);
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

  if (service.runCommands) {
    run(service, "schtasks.exe", ["/Create", "/TN", taskName, "/TR", taskCommand, "/SC", "ONLOGON", "/F"]);
    run(service, "schtasks.exe", ["/Run", "/TN", taskName]);
  }

  return { platform: service.platform, label: service.label, taskName, logsDir: service.logsDir, installed: true };
}

function uninstallScheduledTask(service: ResolvedWatchService): WatchServiceResult {
  const taskName = scheduledTaskName(service);
  if (service.runCommands) {
    runIgnoringFailure(service, "schtasks.exe", ["/End", "/TN", taskName]);
    runIgnoringFailure(service, "schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
  }
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
  return `\\CodeButler\\watch-${service.hash}`;
}

function windowsTaskCommand(service: ResolvedWatchService): string {
  return watchArgs(service).map(windowsArg).join(" ");
}

function watchArgs(service: ResolvedWatchService): string[] {
  return [service.nodePath, service.cliPath, "watch", "--interval", String(service.intervalSeconds), "--source", service.source];
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
  execFileSync(command, args, { stdio: "ignore" });
}

function systemdArg(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsArg(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
