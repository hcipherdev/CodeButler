// Tests aiClientStatus(), checkedAiClientStatus(), autoConnectAiClients(), connectAiClient() and stableLauncher() in src/desktop/ai-clients.ts with fake CLIs and settings files, and probeMcpLauncher() in src/desktop/mcp-probe.ts with fake servers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveGlobalAiSettings } from "../../src/config.js";
import { aiClientStatus, autoConnectAiClients, checkedAiClientStatus, connectAiClient, stableLauncher, type AiClientOptions } from "../../src/desktop/ai-clients.js";
import { probeMcpLauncher } from "../../src/desktop/mcp-probe.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const home = "/Users/dev";
const launcher = "/usr/local/bin/code-butler";
const claudeCli = `${home}/.local/bin/claude`;
const codexCli = "/Applications/Codex.app/Contents/Resources/codex";
const claudeConfig = `${home}/.claude.json`;
const macDesktopConfig = `${home}/Library/Application Support/Claude/claude_desktop_config.json`;

interface Call { command: string; args: string[]; verbatim?: boolean }
function fakeMachine(input: { files?: Record<string, string>; clis?: string[]; codexEntry?: unknown; addFails?: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }) {
  const files: Record<string, string> = { [launcher]: "", ...input.files };
  const clis = new Set(input.clis ?? []);
  const calls: Call[] = [];
  const backups: string[] = [];
  let codexEntry = input.codexEntry;
  const options: AiClientOptions = {
    home, platform: input.platform ?? "darwin", env: input.env ?? { PATH: "/usr/bin:/bin" },
    exists: path => path in files || clis.has(path),
    readText: path => files[path],
    backup: path => { backups.push(path); },
    run: (command, args, spawnOptions) => {
      calls.push({ command, args, ...(spawnOptions.windowsVerbatimArguments ? { verbatim: true } : {}) });
      const cli = command.endsWith("cmd.exe") ? args.at(-1)!.split('"')[2]! : command;
      if (!clis.has(cli)) return { status: null, stdout: "" };
      const tail = command.endsWith("cmd.exe") ? [] : args;
      if (tail[0] === "--version" || command.endsWith("cmd.exe")) return { status: 0, stdout: "1.0.0" };
      if (cli === codexCli && tail[1] === "get") return codexEntry ? { status: 0, stdout: JSON.stringify(codexEntry) } : { status: 1, stdout: "" };
      if (tail[1] === "add") {
        if (input.addFails) return { status: 1, stdout: "" };
        const target = tail.slice(tail.indexOf("--") + 1);
        const entry = { command: target[0], args: target.slice(1) };
        if (cli === codexCli) codexEntry = { enabled: true, transport: { type: "stdio", ...entry } };
        else files[claudeConfig] = JSON.stringify({ mcpServers: { "code-butler": { type: "stdio", ...entry } } });
      }
      return { status: 0, stdout: "" };
    }
  };
  return { options, calls, backups, files };
}

describe("AI client connection status", () => {
  it("reports a user-scope Claude Code entry as connected and a missing Codex as not found", () => {
    const { options } = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ mcpServers: { "code-butler": { command: launcher, args: ["mcp"] } } }) } });
    const status = aiClientStatus(options);
    expect(status.launcherInstalled).toBe(true);
    expect(status.clients).toEqual([
      expect.objectContaining({ client: "claude", state: "connected", cliFound: true, canConnect: true }),
      expect.objectContaining({ client: "codex", state: "missing", cliFound: false, canConnect: true, detail: "No Codex CLI was found. Connect can add Code Butler to Codex settings directly.",
        manualCommand: `codex mcp add code-butler -- ${launcher} mcp` })
    ]);
  });

  it("distinguishes project-only, custom and unreadable Claude Code settings", () => {
    const partial = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ projects: { "/a": { mcpServers: { "code-butler": { command: launcher, args: ["mcp"] } } }, "/b": {} } }) } });
    expect(aiClientStatus(partial.options).clients[0]).toMatchObject({ state: "partial", detail: "Connected only in 1 project. Connect to make it available everywhere." });
    const custom = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ mcpServers: { "code-butler": { command: "node", args: ["/src/code-butler/dist/cli.js", "mcp"] } } }) } });
    expect(aiClientStatus(custom.options).clients[0]).toMatchObject({ state: "custom" });
    const broken = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: "{not json" } });
    expect(aiClientStatus(broken.options).clients[0]).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["D:\\Tools With Spaces\\claude.exe", { Path: '"D:\\Tools With Spaces"' }],
    ["D:\\Tools\\claude.cmd", { PATH: "D:\\Tools" }],
    ["C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe", { PATH: "C:\\Windows" }]
  ])("finds and validates the Windows Claude CLI at %s", (cli, env) => {
    const machine = fakeMachine({ platform: "win32", env, clis: [cli] });
    const options = { ...machine.options, home: "C:\\Users\\dev" };
    expect(aiClientStatus(options).clients[0]).toMatchObject({ state: "missing", cliFound: true });
    expect(machine.calls).toContainEqual(cli.endsWith(".cmd")
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", '""D:\\Tools\\claude.cmd" "--version""'], verbatim: true }
      : { command: cli, args: ["--version"] });
  });

  it("uses the saved Claude CLI path on macOS when GUI discovery misses it", () => {
    const directory = makeTempDir();
    const cli = "/opt/custom-tools/bin/claude";
    vi.stubEnv("CODE_BUTLER_HOME", directory);
    try {
      saveGlobalAiSettings({ connections: { custom: { kind: "claude-code", cliPath: cli } } });
      const machine = fakeMachine({ clis: [cli] });
      expect(aiClientStatus(machine.options).clients[0]).toMatchObject({ state: "missing", cliFound: true, canConnect: true });
      expect(connectAiClient("claude", machine.options)).toMatchObject({ state: "connected" });
      expect(machine.calls).toContainEqual({ command: cli, args: ["mcp", "add", "--scope", "user", "code-butler", "--", launcher, "mcp"] });
    } finally {
      vi.unstubAllEnvs();
      cleanupTempDir(directory);
    }
  });

  it.each([
    { platform: "darwin", config: macDesktopConfig, home },
    { platform: "win32", config: "C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json", home: "C:\\Users\\dev" },
    { platform: "win32", config: "C:\\Users\\dev\\AppData\\Local\\Packages\\Claude_example\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json", home: "C:\\Users\\dev" }
  ] as const)("recognizes a Desktop-only registration in $config without a CLI", async ({ platform, config, home }) => {
    const machine = fakeMachine({ platform, env: {} });
    const options = { ...machine.options, home, listDirectories: () => ["Claude_example"] };
    const spec = stableLauncher(options);
    for (const file of [spec.command, ...spec.args.slice(0, -1)]) machine.files[file] = "";
    machine.files[config] = JSON.stringify({ mcpServers: { "code-butler": spec } });
    const status = await checkedAiClientStatus({ ...options, probe: async () => ({ ok: true, tools: 34, durationMs: 90 }) });
    expect(status.serverCheck).toMatchObject({ ok: true });
    expect(status.clients[0]).toMatchObject({
      state: "connected", cliFound: false, canConnect: false, manualCommand: "",
      detail: "Registered for local Claude Desktop sessions. Code Butler started successfully."
    });
  });

  it("verifies the Codex entry through its CLI, accepting launchers older releases registered", () => {
    const legacy = fakeMachine({ clis: [codexCli], codexEntry: { enabled: true, transport: { type: "stdio", command: `${home}/.local/share/CodeButler/node24/code-butler`, args: ["mcp"] } } });
    expect(aiClientStatus(legacy.options).clients[1]).toMatchObject({ state: "connected", cliFound: true });
    const pinned = fakeMachine({ clis: [codexCli], codexEntry: { enabled: true, transport: { type: "stdio", command: launcher, args: ["mcp"], cwd: "/somewhere" } } });
    expect(aiClientStatus(pinned.options).clients[1]).toMatchObject({ state: "outdated" });
    const unverified = fakeMachine({ files: { [`${home}/.codex/config.toml`]: '[mcp_servers.code-butler]\ncommand = "x"\n' } });
    expect(aiClientStatus(unverified.options).clients[1]).toMatchObject({ state: "unknown", cliFound: false });
  });

  it("cannot connect before the stable launcher is installed", () => {
    const { options, files } = fakeMachine({ clis: [claudeCli] });
    delete files[launcher];
    const status = aiClientStatus(options);
    expect(status.launcherInstalled).toBe(false);
    expect(status.clients[0]).toMatchObject({ client: "claude", cliFound: true, canConnect: false });
    expect(() => connectAiClient("claude", options)).toThrow("not installed yet");
  });
});

describe("connecting an AI client", () => {
  it("backs up Claude Code settings, replaces a custom entry, and keeps its environment", () => {
    const machine = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ mcpServers: { "code-butler": { command: "node", args: ["cli.js", "mcp"], env: { CODE_BUTLER_HOME: "/data" } } } }) } });
    expect(connectAiClient("claude", machine.options)).toMatchObject({ state: "connected" });
    expect(machine.backups).toEqual([claudeConfig]);
    const cliCalls = machine.calls.filter(call => call.command === claudeCli && call.args[0] === "mcp").map(call => call.args);
    expect(cliCalls).toEqual([
      ["mcp", "remove", "code-butler", "--scope", "user"],
      ["mcp", "add", "--scope", "user", "code-butler", "-e", "CODE_BUTLER_HOME=/data", "--", launcher, "mcp"]
    ]);
  });

  it("registers Codex and never echoes settings that may hold credentials", () => {
    const ok = fakeMachine({ clis: [codexCli] });
    expect(connectAiClient("codex", ok.options)).toMatchObject({ state: "connected" });
    const failing = fakeMachine({ clis: [codexCli], addFails: true, codexEntry: { enabled: true, transport: { type: "stdio", command: "node", args: ["x", "mcp"], env: { API_TOKEN: "s3cret-value" } } } });
    let message = "";
    try { connectAiClient("codex", failing.options); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("Codex registration failed; the previous Codex settings were backed up.");
    expect(message).not.toContain("s3cret");
  });

  it("uses the Node launcher on Windows and runs .cmd CLIs through cmd.exe", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", APPDATA: "C:\\Users\\dev\\AppData\\Roaming", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "C:\\Windows" };
    const spec = stableLauncher({ platform: "win32", env, home: "C:\\Users\\dev" });
    expect(spec).toEqual({ command: "C:\\Users\\dev\\AppData\\Local\\CodeButler\\node24\\node.exe",
      args: ["C:\\Users\\dev\\AppData\\Local\\CodeButler\\node24\\node_modules\\code-butler\\dist\\cli.js", "mcp"] });
    const machine = fakeMachine({ platform: "win32", env, clis: ["C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd"] });
    aiClientStatus({ ...machine.options, home: "C:\\Users\\dev" });
    expect(machine.calls.find(call => call.command.endsWith("cmd.exe"))).toMatchObject({ verbatim: true, args: ["/d", "/s", "/c", '""C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd" "--version""'] });
  });
});

describe("automatic client setup and the MCP start check", () => {
  let directory: string;
  afterEach(() => cleanupTempDir(directory));
  const marker = () => join(directory, "auto-connected.json");

  it("connects each installed client once, then leaves a later removal alone", () => {
    directory = makeTempDir();
    const machine = fakeMachine({ clis: [claudeCli, codexCli] });
    const first = autoConnectAiClients({ ...machine.options, autoConnectMarker: marker() });
    expect(first.map(item => [item.client, item.outcome])).toEqual([["claude", "connected"], ["codex", "connected"]]);
    expect(Object.keys(JSON.parse(readFileSync(marker(), "utf8")))).toEqual(["claude", "codex"]);

    delete machine.files[claudeConfig];
    const again = autoConnectAiClients({ ...machine.options, autoConnectMarker: marker() });
    expect(again.map(item => [item.client, item.outcome])).toEqual([["claude", "skipped"], ["codex", "already"]]);
  });

  it("keeps an existing Claude Desktop registration separate from standalone CLI setup", () => {
    directory = makeTempDir();
    const desktop = JSON.stringify({ mcpServers: { "code-butler": { command: "code-butler", args: ["mcp"] } } });
    const machine = fakeMachine({ clis: [claudeCli], files: { [macDesktopConfig]: desktop } });
    expect(aiClientStatus(machine.options).clients[0]).toMatchObject({ state: "custom", canConnect: false, manualCommand: "" });
    expect(autoConnectAiClients({ ...machine.options, autoConnectMarker: marker() })[0]).toMatchObject({ outcome: "skipped" });
    expect(machine.calls.some(call => call.args[0] === "mcp")).toBe(false);
    expect(connectAiClient("claude", machine.options)).toMatchObject({ state: "connected" });
    expect(machine.files[macDesktopConfig]).toBe(desktop);
    expect(machine.backups).toEqual([]);
  });

  it("repairs a pinned legacy Codex entry with its environment, but never a custom or disabled one", () => {
    directory = makeTempDir();
    const pinned = fakeMachine({ clis: [codexCli], codexEntry: { enabled: true, transport: { type: "stdio", command: "npx", args: ["code-butler", "mcp"], cwd: "/old/project", env: { CODE_BUTLER_HOME: "/custom/config" } } } });
    expect(autoConnectAiClients({ ...pinned.options, autoConnectMarker: marker() }, true)[1]).toMatchObject({ client: "codex", outcome: "skipped" });
    expect(pinned.calls.some(call => call.args[1] === "add")).toBe(false);
    expect(autoConnectAiClients({ ...pinned.options, autoConnectMarker: marker() })[1]).toMatchObject({ client: "codex", outcome: "connected" });
    expect(pinned.calls.find(call => call.args[1] === "add")?.args).toEqual(["mcp", "add", "code-butler", "--env", "CODE_BUTLER_HOME=/custom/config", "--", launcher, "mcp"]);

    const custom = fakeMachine({ clis: [codexCli], codexEntry: { enabled: true, transport: { type: "stdio", command: "node", args: ["/src/code-butler/dist/cli.js", "mcp"] } } });
    const disabled = fakeMachine({ clis: [codexCli], codexEntry: { enabled: false, transport: { type: "stdio", command: launcher, args: ["mcp"] } } });
    for (const machine of [custom, disabled]) {
      cleanupTempDir(directory); directory = makeTempDir();
      expect(autoConnectAiClients({ ...machine.options, autoConnectMarker: marker() })[1]).toMatchObject({ outcome: "skipped" });
      expect(machine.calls.some(call => call.args[1] === "add")).toBe(false);
    }
  });

  it("marks a registered client as failing when the installed command does not start", async () => {
    directory = makeTempDir();
    const { options } = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ mcpServers: { "code-butler": { command: launcher, args: ["mcp"] } } }) } });
    let probes = 0;
    const failed = await checkedAiClientStatus({ ...options, probeRetryDelayMs: 0, probe: async () => { probes += 1; return { ok: false, reason: "blocked", detail: "The runtime was stopped as soon as it started.", fix: "Allow it." }; } });
    expect(failed.clients[0]).toMatchObject({ state: "failing", detail: "Registered, but Code Butler does not start: The runtime was stopped as soon as it started. Allow it." });
    expect(probes).toBe(2);
    const passed = await checkedAiClientStatus({ ...options, probe: async () => ({ ok: true, tools: 34, durationMs: 400 }) });
    expect(passed).toMatchObject({ serverCheck: { ok: true }, clients: [{ state: "connected" }, { state: "missing" }] });
  });

  it("retries a failed start once, so a runtime swapped mid-update does not mark clients failing", async () => {
    directory = makeTempDir();
    const { options } = fakeMachine({ clis: [claudeCli], files: { [claudeConfig]: JSON.stringify({ mcpServers: { "code-butler": { command: launcher, args: ["mcp"] } } }) } });
    let probes = 0;
    const recovered = await checkedAiClientStatus({ ...options, probeRetryDelayMs: 0, probe: async () => (probes += 1) === 1
      ? { ok: false, reason: "exited", detail: "The command exited early.", fix: "Reinstall." }
      : { ok: true, tools: 34, durationMs: 90 } });
    expect(recovered).toMatchObject({ serverCheck: { ok: true }, clients: [{ state: "connected" }, { state: "missing" }] });
    expect(probes).toBe(2);

    let timeouts = 0;
    const slow = await checkedAiClientStatus({ ...options, probeRetryDelayMs: 0, probe: async () => { timeouts += 1; return { ok: false, reason: "timeout", detail: "No answer within 15 seconds.", fix: "Check it." }; } });
    expect(slow.clients[0]).toMatchObject({ state: "failing" });
    expect(timeouts).toBe(1);
  });
});

describe("probing the MCP command", () => {
  const fakeServer = (script: string) => ({ command: process.execPath, args: ["-e", script] });

  it("accepts a server that answers initialize and tools/list", async () => {
    const result = await probeMcpLauncher(fakeServer(`
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", line => { const m = JSON.parse(line); if (m.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        if (m.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{}, {}] } })); });`));
    expect(result).toMatchObject({ ok: true, tools: 2 });
  });

  it.each([
    ["missing", { command: "/nonexistent/code-butler", args: ["mcp"] }],
    ["protocol", fakeServer(`console.log("Welcome to Code Butler"); setInterval(() => {}, 1000);`)],
    ["exited", fakeServer(`console.error("No Git repository found for Code Butler MCP startup."); process.exit(1);`)],
    ["blocked", fakeServer(`process.kill(process.pid, "SIGKILL");`)],
    ["architecture", fakeServer(`console.error("zsh: bad CPU type in executable: node"); process.exit(126);`)]
  ] as const)("classifies a %s failure with a fix", async (reason, launcherSpec) => {
    const result = await probeMcpLauncher(launcherSpec, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ ok: false, reason, fix: expect.any(String) });
  });

  it("reports a server that never answers as a timeout", async () => {
    expect(await probeMcpLauncher(fakeServer("setInterval(() => {}, 1000);"), { timeoutMs: 500 })).toMatchObject({ ok: false, reason: "timeout" });
  });
});
