// Tests aiClientStatus(), connectAiClient() and stableLauncher() in src/desktop/ai-clients.ts with fake CLIs and settings files.
import { describe, expect, it } from "vitest";
import { aiClientStatus, connectAiClient, stableLauncher, type AiClientOptions } from "../../src/desktop/ai-clients.js";

const home = "/Users/dev";
const launcher = "/usr/local/bin/code-butler";
const claudeCli = `${home}/.local/bin/claude`;
const codexCli = "/Applications/Codex.app/Contents/Resources/codex";
const claudeConfig = `${home}/.claude.json`;

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
      expect.objectContaining({ client: "codex", state: "missing", cliFound: false, canConnect: false, detail: "Codex was not found on this computer.",
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
