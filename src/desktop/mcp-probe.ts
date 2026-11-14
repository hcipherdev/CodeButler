import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Why the code-butler MCP command did not answer like a working server. */
export type McpProbeFailure = "missing" | "blocked" | "architecture" | "timeout" | "protocol" | "exited";
export type McpProbeResult =
  | { ok: true; tools: number; durationMs: number }
  | { ok: false; reason: McpProbeFailure; detail: string; fix: string; stderr?: string };

export interface McpProbeOptions {
  timeoutMs?: number;
  spawnProcess?: (command: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}

const STDERR_TAIL = 2048;
const FIXES: Record<McpProbeFailure, string> = {
  missing: "Reinstall Code Butler to restore its runtime.",
  blocked: "macOS stopped the runtime. Open Code Butler once, or allow it in System Settings › Privacy & Security, then check again.",
  architecture: "This Code Butler build does not match this computer's processor. Install the build for this Mac.",
  timeout: "The server started too slowly. Check again; if it keeps happening, run `code-butler doctor`.",
  protocol: "The server printed something other than MCP messages. Please report this with the details below.",
  exited: "Run `code-butler doctor` for details."
};

/**
 * Start the MCP command the way an AI client does, from a folder outside any project,
 * and check that it answers `initialize` and `tools/list` with clean JSON-RPC.
 */
export function probeMcpLauncher(launcher: { command: string; args: readonly string[] }, options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const started = Date.now();
  const cwd = mkdtempSync(join(tmpdir(), "code-butler-probe-"));
  const spawnProcess = options.spawnProcess ?? ((command, args, directory) => spawn(command, args, { cwd: directory, stdio: "pipe", windowsHide: true }));
  return new Promise(resolve => {
    let stderr = "";
    let stdout = "";
    let settled = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin.end();
      const kill = setTimeout(() => child?.kill(), 2_000);
      kill.unref();
      child?.once("exit", () => { clearTimeout(kill); rmSync(cwd, { recursive: true, force: true }); });
      if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(cwd, { recursive: true, force: true });
      resolve(result);
    };
    const fail = (reason: McpProbeFailure, detail: string): void => {
      const tail = stderr.trim().slice(-STDERR_TAIL);
      finish({ ok: false, reason, detail, fix: FIXES[reason], ...(tail ? { stderr: tail } : {}) });
    };
    const send = (message: object): void => { child?.stdin.write(`${JSON.stringify(message)}\n`); };
    const timer = setTimeout(() => fail("timeout", `No answer within ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs);
    try {
      child = spawnProcess(launcher.command, launcher.args, cwd);
    } catch (error) {
      fail(spawnFailure(error), errorMessage(error));
      return;
    }
    const running = child;
    running.on("error", error => fail(spawnFailure(error), errorMessage(error)));
    running.stdin.on("error", () => { /* An exit before reading stdin is reported by the exit handler. */ });
    running.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-STDERR_TAIL * 2); });
    running.stdout.on("data", data => {
      stdout += String(data);
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: { tools?: unknown[] }; error?: { message?: string } };
        try { message = JSON.parse(line); } catch {
          fail("protocol", `Unexpected output: ${line.slice(0, 200)}`);
          return;
        }
        if (message.error) { fail("protocol", message.error.message ?? "The server returned an error."); return; }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          finish({ ok: true, tools: message.result?.tools?.length ?? 0, durationMs: Date.now() - started });
        }
      }
    });
    running.on("exit", (code, signal) => {
      if (settled) return;
      if (signal === "SIGKILL") fail("blocked", "The runtime was stopped as soon as it started.");
      else if (/bad cpu type|exec format error/i.test(stderr)) fail("architecture", lastLine(stderr));
      else if (code === 127 || /no such file or directory|not found/i.test(stderr)) fail("missing", lastLine(stderr) || "The runtime could not be found.");
      else fail("exited", lastLine(stderr) || `The server exited with ${signal ?? `code ${code}`} before answering.`);
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "code-butler-check", version: "1" } } });
  });
}

function spawnFailure(error: unknown): McpProbeFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "blocked";
  return /-86|bad cpu type|exec format/i.test(errorMessage(error)) ? "architecture" : "exited";
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
