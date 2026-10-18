import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it, vi } from "vitest";
import { saveBinding } from "../src/cloud/state.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { runtimeDiagnostics } from "../src/runtime.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

it("coordinates two real MCP clients, five watcher passes, failover and handback", async () => {
  const directory = makeTempDir(); const root = join(directory, "project"); const home = join(directory, "home");
  vi.stubEnv("CODE_BUTLER_HOME", home);
  mkdirSync(join(root, ".code-butler"), { recursive: true });
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({ sources: { git: { enabled: false }, codex: { enabled: false }, claude: { enabled: false } }, sync: { autoSyncOnServerStart: false } }));
  const store = openConfiguredMemoryStore(root); store.init(); store.close();
  saveBinding(root, { server: "http://127.0.0.1", projectId: "fixture", vaultId: "fixture", enabled: true, revision: 0, fingerprint: "", status: "synced" });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CODE_BUTLER_HOME: home, BUTLER_TEST_PROJECT: root };
  const fixture = join(process.cwd(), "tests", "fixtures", "scheduler-process.ts");
  const clients: Client[] = []; const transports: StdioClientTransport[] = []; const watchers: ChildProcess[] = [];
  const events = (): Array<{ name: string; pid: number; role: string; time: number }> => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const waitFor = async (predicate: () => boolean, timeout = 20000) => { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(events().slice(-10))}`); await new Promise(resolve => setTimeout(resolve, 100)); } };
  const launchWatcher = () => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, "watcher"], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    watchers.push(child); return child;
  };
  try {
    const watcher = launchWatcher();
    await waitFor(() => events().some(event => event.name === "pass"));
    for (let i = 0; i < 2; i++) {
      const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", fixture, "mcp"], env, stderr: "pipe" });
      const client = new Client({ name: `concurrent-${i}`, version: "1" }); clients.push(client); transports.push(transport);
      await client.connect(transport);
    }
    for (let i = 0; i < 5; i++) {
      await Promise.all(clients.map(client => client.callTool({ name: "current_project", arguments: {} })));
      await clients[i % 2]!.callTool({ name: "remember_project_memory", arguments: { type: "decision", title: `Fixture ${i}`, text: `Concurrent fixture memory ${i}`, reason: "Verify coordinated runtime" } });
    }
    await waitFor(() => events().filter(event => event.name === "pass").length >= 5);
    expect(events().filter(event => event.name === "start").every(event => event.role === "watcher")).toBe(true);
    watcher.send("stop"); await waitFor(() => watcher.exitCode !== null);
    const stoppedAt = Date.now();
    await waitFor(() => events().some(event => event.role === "mcp" && event.name === "start"), 10000);
    expect(Date.now() - stoppedAt).toBeLessThan(10000);
    const owner = events().filter(event => event.role === "mcp" && event.name === "start").at(-1)!.pid;
    // End the owning client's stdin directly: cleanup must not rely on client.close() killing it.
    const ownerIndex = transports.findIndex(transport => transport.pid === owner);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    const child = (transports[ownerIndex] as unknown as { _process: ChildProcess })._process;
    child.stdin!.end();
    await waitFor(() => child.exitCode !== null);
    await waitFor(() => events().some(event => event.role === "mcp" && event.name === "start" && event.pid !== owner));
    const successor = events().filter(event => event.role === "mcp" && event.name === "start" && event.pid !== owner).at(-1)!.pid;
    const successorIndex = transports.findIndex(transport => transport.pid === successor);
    const successorChild = (transports[successorIndex] as unknown as { _process: ChildProcess })._process;
    // Abrupt process death must reclaim the ownership record as well.
    successorChild.kill(); await waitFor(() => successorChild.exitCode !== null || successorChild.signalCode !== null);
    const replacementTransport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", fixture, "mcp"], env, stderr: "pipe" });
    const replacement = new Client({ name: "replacement", version: "1" }); clients.push(replacement); transports.push(replacementTransport);
    await replacement.connect(replacementTransport);
    await waitFor(() => events().some(event => event.name === "start" && event.pid === replacementTransport.pid));
    expect((await replacement.callTool({ name: "current_project", arguments: {} })).isError).not.toBe(true);
    const secondWatcher = launchWatcher();
    await waitFor(() => events().some(event => event.name === "pass" && event.pid === secondWatcher.pid));
    const marker = events().filter(event => event.pid === secondWatcher.pid && event.name === "pass").at(-1)!.time;
    await waitFor(() => events().filter(event => event.pid === secondWatcher.pid && event.name === "pass").length >= 3);
    expect(events().filter(event => event.time > marker && event.role === "mcp" && event.name === "start")).toHaveLength(0);
    expect(events().some(event => event.name === "overlap")).toBe(false);
    expect(runtimeDiagnostics().some(record => record.pid === owner)).toBe(false);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    for (const watcher of watchers) if (watcher.exitCode === null) { if (watcher.connected) watcher.send("stop"); await waitFor(() => watcher.exitCode !== null).catch(() => watcher.kill()); }
    vi.unstubAllEnvs(); cleanupTempDir(directory);
  }
}, 120000);
