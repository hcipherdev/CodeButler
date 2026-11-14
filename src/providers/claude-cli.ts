import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AiConnectionError } from "../ai/errors.js";
import { cliCandidates, cliChildEnv, cliCommand, cliPath, type CliMachine } from "../ai/cli-locator.js";
import type { ChatResult } from "./openai-compatible.js";

export interface ClaudeCliRequest {
  model: string;
  system: string;
  user: string;
  cliPath?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}
export interface ClaudeCliRunResult { code: number | null; stdout: string; stderr: string }
export type ClaudeCliRunner = (command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; signal?: AbortSignal | undefined; windowsVerbatimArguments?: true;
}) => Promise<ClaudeCliRunResult>;
export interface ClaudeCliDeps { machine?: CliMachine; exists?: (path: string) => boolean; run?: ClaudeCliRunner }

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const CLAUDE_CLI_NOT_FOUND = "Claude Code is not installed or could not be found. Install it from code.claude.com, or set its path in Code Butler's AI models settings.";
export const CLAUDE_CLI_SIGNED_OUT = "Claude Code is not signed in. Open a terminal, run `claude`, and sign in with your Claude account.";

const realMachine = (): CliMachine => ({ home: homedir(), platform: process.platform, env: process.env });

/** The CLI to run without starting it: a configured path, a known install location, or a match on PATH. */
export function locateClaudeCli(configured: string | undefined, deps: ClaudeCliDeps = {}): string | undefined {
  const machine = deps.machine ?? realMachine(), exists = deps.exists ?? existsSync, path = cliPath(machine);
  if (configured?.trim()) return exists(configured.trim()) ? configured.trim() : undefined;
  for (const candidate of cliCandidates(machine, "claude")) {
    if (path.isAbsolute(candidate)) { if (exists(candidate)) return candidate; continue; }
    const names = machine.platform === "win32" ? [`${candidate}.exe`, `${candidate}.cmd`] : [candidate];
    const dirs = (cliChildEnv(machine, candidate).PATH ?? "").split(machine.platform === "win32" ? ";" : ":");
    for (const dir of dirs) for (const name of names) if (dir && exists(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

/**
 * The child runs on the person's own Claude Code sign-in. API keys are removed so it cannot silently bill
 * an account instead, and Code Butler's own variables are removed so it is never mistaken for a watcher.
 */
export function claudeCliEnv(machine: CliMachine, cli: string): NodeJS.ProcessEnv {
  const env = cliChildEnv(machine, cli);
  for (const name of Object.keys(env)) {
    if (name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN" || name.startsWith("CODE_BUTLER_")) delete env[name];
  }
  return env;
}

/**
 * Print mode with no tools, no MCP servers, no settings or hooks and no saved session: a plain model call.
 * `--bare` is deliberately absent; it never reads the sign-in, so it would need an API key.
 */
export function claudeCliArgs(model: string, systemPromptFile: string): string[] {
  return ["-p", "--output-format", "json", "--model", model, "--system-prompt-file", systemPromptFile,
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];
}

// One call at a time: each call starts a whole Claude Code process, and the plan is the person's own.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export function claudeCliChat(request: ClaudeCliRequest, deps: ClaudeCliDeps = {}): Promise<ChatResult> {
  return serialized(() => runClaudeCli(request, deps));
}

async function runClaudeCli(request: ClaudeCliRequest, deps: ClaudeCliDeps): Promise<ChatResult> {
  const machine = deps.machine ?? realMachine();
  const cli = locateClaudeCli(request.cliPath, deps);
  if (!cli) throw new AiConnectionError(CLAUDE_CLI_NOT_FOUND);
  request.signal?.throwIfAborted();
  // An empty working directory keeps project CLAUDE.md files, hooks and MCP configuration out of the call.
  const cwd = mkdtempSync(join(tmpdir(), "code-butler-claude-"));
  try {
    const systemFile = join(cwd, "system-prompt.txt");
    writeFileSync(systemFile, request.system, { mode: 0o600 });
    const command = cliCommand(machine, cli, claudeCliArgs(request.model, systemFile));
    const result = await (deps.run ?? spawnRunner)(command.command, command.args, {
      cwd, env: claudeCliEnv(machine, cli), stdin: request.user, timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: request.signal,
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {})
    });
    return parseClaudeCliOutput(result);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface ClaudeCliJson {
  type?: string; subtype?: string; is_error?: boolean; result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export function parseClaudeCliOutput(result: ClaudeCliRunResult): ChatResult {
  let parsed: ClaudeCliJson | undefined;
  try { parsed = JSON.parse(result.stdout.trim()) as ClaudeCliJson; } catch { parsed = undefined; }
  const message = (parsed?.result ?? result.stderr ?? result.stdout).trim();
  if (/not logged in|please run \/login|invalid api key|oauth token has expired/i.test(message)) throw new AiConnectionError(CLAUDE_CLI_SIGNED_OUT);
  if (!parsed || parsed.type !== "result") {
    throw new AiConnectionError(`Claude Code failed${result.code !== null ? ` (exit ${result.code})` : ""}: ${bounded(message) || "no output"}`);
  }
  if (parsed.is_error || parsed.subtype !== "success" || typeof parsed.result !== "string") {
    throw new AiConnectionError(`Claude Code request failed: ${bounded(message) || parsed.subtype || "unknown error"}`);
  }
  const usage = parsed.usage;
  const input = usage && typeof usage.input_tokens === "number"
    ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    : undefined;
  // No costUsd: the person's plan is not billed per token.
  return {
    content: parsed.result,
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {})
  };
}

function bounded(text: string): string { return text.length > 500 ? `${text.slice(0, 500)}…` : text; }

const spawnRunner: ClaudeCliRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, settled = false;
  const finish = (error?: Error, code: number | null = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (error) { child.kill(); reject(error); return; }
    resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  };
  const abort = () => finish(new Error("Claude Code request was cancelled"));
  const timer = setTimeout(() => finish(new Error("Claude Code request timed out")), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) finish(new Error("Claude Code returned oversized output"));
    else into.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.on("error", error => finish(new Error(`Could not start Claude Code: ${error.message}`)));
  child.on("close", code => finish(undefined, code));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
});
