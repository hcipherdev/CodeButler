import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";
import { atomicJson, readJson } from "./cloud/state.js";

export interface BuildInfo { version: string; buildId: string; builtAt: string }
declare const __BUTLER_BUILD__: BuildInfo | undefined;
export const buildInfo: BuildInfo = typeof __BUTLER_BUILD__ !== "undefined" ? __BUTLER_BUILD__! : (() => {
  try { return JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as BuildInfo; }
  catch { return { version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string, buildId: "development", builtAt: "unpackaged" }; }
})();

export interface ProcessIdentity { pid: number; processStart?: string }
export interface RuntimeRecord extends ProcessIdentity {
  token: string; startedAt: string; role: "mcp" | "watcher" | "legacy-watcher";
  project?: string; executable: string; entrypoint: string; build: BuildInfo;
}
let ownBirth: string | undefined;
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
export function processStartIdentity(pid: number): string | undefined {
  // Only our own PID is safe to cache. Caching another process's birth could
  // falsely classify its replacement as dead if Windows reuses that PID.
  if (pid === process.pid && ownBirth) return ownBirth;
  try {
    let value: string;
    if (process.platform === "win32") {
      value = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } else if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    } else {
      value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    }
    if (!value) return undefined;
    if (pid === process.pid) ownBirth = value;
    return value;
  } catch { return undefined; }
}
export function processIsLive(identity: ProcessIdentity): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  try { process.kill(identity.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; }
  const current = identity.processStart ? processStartIdentity(identity.pid) : undefined;
  // Inaccessible processes are not evidence that it is safe to steal ownership.
  return !current || !identity.processStart || current === identity.processStart;
}
export function newRuntimeRecord(role: RuntimeRecord["role"], project?: string): RuntimeRecord {
  const processStart = processStartIdentity(process.pid);
  return { pid: process.pid, ...(processStart ? { processStart } : {}), token: randomUUID(), startedAt,
    role, ...(project ? { project } : {}), executable: process.execPath, entrypoint: process.argv[1] ?? "", build: buildInfo };
}
const runtimeDirectory = () => join(globalConfigDir(), "runtimes");
export function registerRuntime(record: RuntimeRecord): () => void {
  const path = join(runtimeDirectory(), `${record.token}.json`);
  mkdirSync(runtimeDirectory(), { recursive: true }); atomicJson(path, record);
  return () => { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
}
export function runtimeDiagnostics(): RuntimeRecord[] {
  if (!existsSync(runtimeDirectory())) return [];
  const candidates: Array<{ path: string; record: RuntimeRecord }> = [];
  for (const name of readdirSync(runtimeDirectory()).filter(value => value.endsWith(".json"))) {
    const path = join(runtimeDirectory(), name);
    try {
      const record = readJson<RuntimeRecord>(path);
      if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
      try { process.kill(record.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { try { unlinkSync(path); } catch { /* Another process may have removed it. */ } continue; }
      }
      candidates.push({ path, record });
    } catch { /* Ignore invalid runtime records. */ }
  }
  if (process.platform !== "win32") return candidates.flatMap(({ path, record }) => {
    if (processIsLive(record)) return [record];
    try { unlinkSync(path); } catch { /* Another process may have removed it. */ }
    return [];
  });
  const identities = windowsProcessStartIdentities(candidates.map(item => item.record.pid));
  return candidates.flatMap(({ path, record }) => {
    const start = identities?.get(record.pid);
    if (start && record.processStart && record.processStart !== start) {
      try { unlinkSync(path); } catch { /* Another process may have removed it. */ }
      return [];
    }
    return [record];
  });
}

function windowsProcessStartIdentities(pids: number[]): Map<number, string> | undefined {
  if (pids.length === 0) return new Map();
  const ids = [...new Set(pids)];
  try {
    const command = `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { '{0}:{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks }`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const result = new Map<number, string>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+):(\d+)$/.exec(line.trim());
      if (match) result.set(Number(match[1]), match[2]!);
    }
    return result;
  } catch {
    // An unavailable process query is not proof that a live runtime is stale.
    return undefined;
  }
}
