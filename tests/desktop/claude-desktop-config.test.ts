// Tests Claude Desktop detection and explicit MCP registration through aiClientStatus() and connectClaudeDesktop().
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiClientStatus, autoConnectAiClients, checkedAiClientStatus, connectClaudeDesktop, stableLauncher, type AiClientOptions } from "../../src/desktop/ai-clients.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let home: string;
let macConfig: string;
let mac: AiClientOptions;
const launcher = "/usr/local/bin/code-butler";

beforeEach(() => {
  home = makeTempDir();
  macConfig = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const bundle = join(home, "Applications", "Claude.app", "Contents", "MacOS", "Claude");
  mac = { home, platform: "darwin", env: {}, run: () => ({ status: 1, stdout: "" }),
    exists: path => path === bundle || path === launcher || existsSync(path), autoConnectMarker: join(home, "marker.json") };
});
afterEach(() => cleanupTempDir(home));

function saveMac(text: string): void {
  mkdirSync(dirname(macConfig), { recursive: true });
  writeFileSync(macConfig, text);
}

it("offers explicit setup on macOS, preserves settings and backs them up only once", async () => {
  const original = '{\r\n  "preferences": {"theme":"dark"},\r\n  "mcpServers": {"other":{"command":"other"}}\r\n}\r\n';
  saveMac(original);
  expect(aiClientStatus(mac).clients[0]).toMatchObject({
    label: "Claude Desktop", cliFound: false, state: "missing", canConnect: true, connectTarget: "claude-desktop", manualCommand: ""
  });
  expect(autoConnectAiClients(mac)[0]?.outcome).toBe("skipped");
  expect(readFileSync(macConfig, "utf8")).toBe(original);
  expect(connectClaudeDesktop(mac)).toEqual({ changed: true });
  expect(connectClaudeDesktop(mac)).toEqual({ changed: false });
  const backups = readdirSync(dirname(macConfig)).filter(name => name.endsWith(".bak"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(dirname(macConfig), backups[0]!), "utf8")).toBe(original);
  const saved = readFileSync(macConfig, "utf8");
  expect(saved.replaceAll("\r\n", "")).not.toContain("\n");
  expect(JSON.parse(saved)).toEqual({
    preferences: { theme: "dark" },
    mcpServers: { other: { command: "other" }, "code-butler": { command: launcher, args: ["mcp"] } }
  });
  expect(aiClientStatus(mac).clients[0]).toMatchObject({ label: "Claude Desktop", state: "configured" });
  const probe = vi.fn(async () => ({ ok: true as const, tools: 1, durationMs: 5 }));
  expect((await checkedAiClientStatus({ ...mac, probe })).clients[0]).toMatchObject({ label: "Claude Desktop", state: "connected" });
  expect(probe).toHaveBeenCalledWith(stableLauncher(mac));
  const failed = await checkedAiClientStatus({ ...mac, probe: async () => ({ ok: false, reason: "timeout", detail: "Timed out.", fix: "Try again." }) });
  expect(failed.clients[0]).toMatchObject({ label: "Claude Desktop", state: "failing" });
});

it("creates a missing macOS config for a detected bundle", () => {
  expect(connectClaudeDesktop(mac)).toEqual({ changed: true });
  expect(JSON.parse(readFileSync(macConfig, "utf8"))).toEqual({ mcpServers: { "code-butler": stableLauncher(mac) } });
});

it("preserves the CLI route and avoids duplicating an inherited registration", () => {
  const cli = join(home, ".local", "bin", "claude");
  const options: AiClientOptions = { ...mac, exists: path => path === cli || mac.exists!(path),
    run: command => ({ status: command === cli ? 0 : 1, stdout: "" }) };
  expect(aiClientStatus(options).clients[0]).toMatchObject({ label: "Claude Code", cliFound: true, canConnect: true });
  expect(() => connectClaudeDesktop(options)).toThrow("Claude setup changed");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "code-butler": stableLauncher(mac) } }));
  expect(aiClientStatus(mac).clients[0]).toMatchObject({ state: "connected", label: "Claude Code" });
  expect(() => connectClaudeDesktop(mac)).toThrow("Claude setup changed");
  expect(existsSync(macConfig)).toBe(false);
});

it.each(["{broken", '{"mcpServers":[]}', '{"mcpServers":{"code-butler":{"command":"custom"}}}',
  '{"mcpServers":{"code-butler":{"command":"/usr/local/bin/code-butler","args":["mcp"],"enabled":false}}}',
  '{"mcpServers":{"code-butler":null}}'
])("refuses malformed settings or an existing nonmatching entry", original => {
  saveMac(original);
  expect(aiClientStatus(mac).clients[0]?.canConnect).toBe(false);
  expect(() => connectClaudeDesktop(mac)).toThrow(/Claude Desktop/);
  expect(readFileSync(macConfig, "utf8")).toBe(original);
  expect(readdirSync(dirname(macConfig))).toEqual(["claude_desktop_config.json"]);
});

it("preserves the original on backup failure and preserves a concurrent edit", () => {
  saveMac('{"original":true}\n');
  expect(() => connectClaudeDesktop({ ...mac, backup: () => { throw new Error("disk full"); } })).toThrow("Could not save");
  expect(readFileSync(macConfig, "utf8")).toBe('{"original":true}\n');
  expect(() => connectClaudeDesktop({ ...mac, backup: path => writeFileSync(path, '{"edited":true}\n') })).toThrow("changed during setup");
  expect(readFileSync(macConfig, "utf8")).toBe('{"edited":true}\n');
  expect(readdirSync(dirname(macConfig))).toEqual(["claude_desktop_config.json"]);
});

it("uses the installed Windows package's settings and refuses missing or ambiguous targets", () => {
  const user = "C:\\Users\\tester";
  const local = user + "\\AppData\\Local";
  const file = local + "\\Packages\\Claude_active\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json";
  const otherLayout = local + "\\Claude-Data\\Claude_active\\claude_desktop_config.json";
  const stale = local + "\\Packages\\Claude_old\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json";
  const files = new Map([[stale, "{}"]]);
  const writeConfig = vi.fn((path: string, _previous: string | undefined, next: string) => { files.set(path, next); });
  const win: AiClientOptions = {
    home: user, platform: "win32", env: { LOCALAPPDATA: local },
    run: command => command.endsWith("\\powershell.exe") ? { status: 0, stdout: "Claude_active\r\n" } : { status: 1, stdout: "" },
    exists: path => files.has(path) || path.startsWith(local + "\\CodeButler\\node24\\"),
    readText: path => files.get(path), writeConfig
  };
  expect(aiClientStatus(win).clients[0]).toMatchObject({ label: "Claude Desktop", state: "unknown", canConnect: false, detail: expect.stringContaining("Edit Config") });
  expect(() => connectClaudeDesktop(win)).toThrow("Edit Config");
  files.set(file, "{}");
  files.set(otherLayout, "{}");
  expect(() => connectClaudeDesktop(win)).toThrow("Edit Config");
  expect(writeConfig).not.toHaveBeenCalled();
  files.delete(otherLayout);
  expect(aiClientStatus(win).clients[0]).toMatchObject({ state: "missing", cliFound: false, canConnect: true });
  expect(connectClaudeDesktop(win)).toEqual({ changed: true });
  expect(writeConfig.mock.calls[0]?.[0]).toBe(file);
  expect(JSON.parse(files.get(file)!)).toEqual({ mcpServers: { "code-butler": stableLauncher(win) } });
  expect(files.get(stale)).toBe("{}");
});
