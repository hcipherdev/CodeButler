// Tests explicit Codex config fallback, Windows discovery, preservation, and atomic failure handling.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { aiClientStatus, autoConnectAiClients, checkedAiClientStatus, connectAiClient, stableLauncher, type AiClientOptions } from "../../src/desktop/ai-clients.js";
import { missingCodexConfig, writeCodexConfig } from "../../src/desktop/codex-config.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let home: string, config: string, options: AiClientOptions;
beforeEach(() => {
  home = makeTempDir(); config = join(home, ".codex", "config.toml");
  options = { home, platform: "darwin", env: {}, exists: path => path === "/usr/local/bin/code-butler" || existsSync(path),
    run: () => ({ status: 1, stdout: "" }), autoConnectMarker: join(home, "auto-connected.json") };
});
afterEach(() => { cleanupTempDir(home); vi.restoreAllMocks(); });
function save(text: string) { mkdirSync(join(home, ".codex"), { recursive: true }); writeFileSync(config, text); }
const codex = () => aiClientStatus(options).clients[1]!;

it("offers explicit configuration without a CLI and never writes it during automatic setup", () => {
  expect(codex()).toMatchObject({ state: "missing", cliFound: false, canConnect: true });
  expect(autoConnectAiClients(options)[1]).toMatchObject({ outcome: "skipped" });
  expect(existsSync(config)).toBe(false);
  expect(connectAiClient("codex", options)).toMatchObject({ state: "configured", cliFound: false, canConnect: false });
  const entry = (parse(readFileSync(config, "utf8")).mcp_servers as Record<string, unknown>)["code-butler"];
  expect(entry).toEqual({ command: "/usr/local/bin/code-butler", args: ["mcp"] });
  if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
  const original = readFileSync(config, "utf8");
  expect(autoConnectAiClients(options)[1]).toMatchObject({ outcome: "already" });
  connectAiClient("codex", options);
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
});

it("preserves unrelated settings, comments, CRLF and private backups", () => {
  const original = '# Keep this comment\r\nmodel = "example"\r\n[mcp_servers.other]\r\ncommand = "other"\r\n';
  save(original); connectAiClient("codex", options);
  const next = readFileSync(config, "utf8"); expect(next.startsWith(original)).toBe(true);
  expect(next.replaceAll("\r\n", "")).not.toContain("\n");
  expect(parse(next)).toMatchObject({ model: "example", mcp_servers: { other: { command: "other" } } });
  const backups = readdirSync(join(home, ".codex")).filter(name => name.endsWith(".bak"));
  expect(backups).toHaveLength(1); const backup = join(home, ".codex", backups[0]!);
  expect(readFileSync(backup, "utf8")).toBe(original); if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
});

it("uses custom CODEX_HOME and escapes a Windows launcher containing spaces and quotes", () => {
  const custom = join(home, "custom"); options.env = { CODEX_HOME: custom };
  connectAiClient("codex", options);
  expect(existsSync(join(custom, "config.toml"))).toBe(true); expect(existsSync(config)).toBe(false);
  const launcher = { command: 'C:\\Users\\Dev Name\\node.exe', args: ['C:\\a "quoted" folder\\cli.js', "mcp"] };
  expect(parse(missingCodexConfig(undefined, launcher))).toEqual({ mcp_servers: { "code-butler": launcher } });
});

it("registers the Windows Node launcher through explicit fallback without a Codex CLI", () => {
  const files = new Map<string, string>();
  const machine: AiClientOptions = { home: "C:\\Users\\Dev Name", platform: "win32", env: {}, run: () => ({ status: 1, stdout: "" }),
    readText: path => files.get(path), exists: path => files.has(path) || path.includes("\\CodeButler\\node24\\"),
    writeConfig: (path, previous, next) => { expect(previous).toBeUndefined(); files.set(path, next); } };
  expect(connectAiClient("codex", machine)).toMatchObject({ state: "configured", cliFound: false });
  const text = files.get("C:\\Users\\Dev Name\\.codex\\config.toml")!;
  expect(parse(text)).toEqual({ mcp_servers: { "code-butler": stableLauncher(machine) } });
  expect(text).not.toContain("cwd");
});

it.each([
  '[mcp_servers.code-butler]\ncommand = "custom"\nargs = ["mcp"]\n',
  '[mcp_servers."code-butler"]\nenabled = false\ncommand = "/usr/local/bin/code-butler"\nargs = ["mcp"]\n',
  'mcp_servers = { "code-butler" = { command = "custom" } }\n',
  'mcp_servers = { other = { command = "other" } }\n',
  'token = "do-not-leak\n',
  'mcp_servers = "unsupported"\n'
])("refuses conflicting, invalid and unextendable settings without changing them", text => {
  save(text); expect(() => connectAiClient("codex", options)).toThrow();
  expect(readFileSync(config, "utf8")).toBe(text);
  expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  expect(codex().detail).not.toContain("do-not-leak"); expect(codex().canConnect).toBe(text.includes('other = {'));
});

it("does not overwrite concurrent edits, including edits during backup", () => {
  const original = 'model = "old"\n', changed = 'model = "new"\n'; save(original);
  const next = missingCodexConfig(original, stableLauncher(options));
  writeFileSync(config, changed);
  expect(() => writeCodexConfig(config, original, next)).toThrow("changed during setup");
  save(original);
  expect(() => writeCodexConfig(config, original, next, path => writeFileSync(path, changed))).toThrow("changed during setup");
  expect(readFileSync(config, "utf8")).toBe(changed);
  expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
});

it("leaves the config intact and removes temporary files after a write or backup failure", () => {
  const original = 'model = "old"\n'; save(original);
  const next = missingCodexConfig(original, stableLauncher(options));
  expect(() => writeCodexConfig(config, original, next, () => { throw new Error("disk full"); })).toThrow("disk full");
  expect(readFileSync(config, "utf8")).toBe(original); expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  expect(() => connectAiClient("codex", { ...options, writeConfig: () => { throw new Error("private OS error"); } })).toThrow("Check permissions");
  expect(readFileSync(config, "utf8")).toBe(original);
});

it("probes a configured launcher and distinguishes startup failure from registration", async () => {
  connectAiClient("codex", options);
  const probe = vi.fn(async () => ({ ok: true as const, tools: 1, durationMs: 1 }));
  expect((await checkedAiClientStatus({ ...options, probe })).clients[1]).toMatchObject({
    state: "configured",
    detail: "Configured for all projects. The Codex CLI is unavailable for verification."
  });
  expect(probe).toHaveBeenCalledOnce();
  expect((await checkedAiClientStatus({ ...options, probeRetryDelayMs: 0, probe: async () => ({ ok: false, reason: "exited", detail: "Stopped", fix: "Repair runtime" }) })).clients[1]).toMatchObject({ state: "failing", cliFound: false });
});

it.each(["codex.exe", "codex.cmd"])("discovers %s on Windows PATH without the npm installation", cli => {
  const run = vi.fn((command: string, args: string[]) => ({ status: command === cli || (command.endsWith("cmd.exe") && args.at(-1)!.includes('"codex.cmd"')) ? 0 : 1, stdout: "1.0.0" }));
  const machine = { home: "C:\\Users\\Dev Name", platform: "win32" as const, env: { PATH: "C:\\Tools With Spaces", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, exists: () => false, run };
  expect(aiClientStatus(machine).clients[1]?.cliFound).toBe(true);
  expect(run).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ PATH: "C:\\Tools With Spaces" }) }));
});

it("verifies Codex registration through a usable Desktop runtime outside Windows PATH", () => {
  const localAppData = "D:\\User Data";
  const runtimeRoot = `${localAppData}\\OpenAI\\Codex\\bin`;
  const unusable = `${runtimeRoot}\\incomplete\\codex.exe`;
  const usable = `${runtimeRoot}\\current-version\\codex.exe`;
  const listDirectories = vi.fn(() => ["incomplete", "removed", "current-version"]);
  const machine: AiClientOptions = {
    home: "C:\\Users\\Dev Name", platform: "win32", env: { LOCALAPPDATA: localAppData },
    exists: path => [unusable, usable].includes(path), listDirectories
  };
  const run = vi.fn((command: string, args: string[]) => {
    if (command !== usable) return { status: 1, stdout: "" };
    if (args[0] === "--version") return { status: 0, stdout: "codex-cli 1.0.0" };
    return { status: 0, stdout: JSON.stringify({ enabled: true, transport: { type: "stdio", ...stableLauncher(machine) } }) };
  });
  expect(aiClientStatus({ ...machine, run }).clients[1]).toMatchObject({ state: "connected", cliFound: true });
  expect(listDirectories).toHaveBeenCalledWith(runtimeRoot);
  expect(run.mock.calls.slice(-3)).toEqual([
    [unusable, ["--version"], expect.anything()],
    [usable, ["--version"], expect.anything()],
    [usable, ["mcp", "get", "code-butler", "--json"], expect.anything()]
  ]);
});
