// Tests startServer() in src/server.ts and current_project binding in src/mcp/project-binding.ts: MCP starts outside a Git repository and binds a project from client roots or the agent's working directory.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const repository = process.cwd();
const tsxLoader = pathToFileURL(join(repository, "node_modules", "tsx", "dist", "loader.mjs")).href;

describe("MCP startup without a project", () => {
  let directory: string;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    cleanupTempDir(directory);
  });

  function gitRepo(name: string): string {
    const root = join(directory, name);
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  async function connect(options: { roots?: string[] } = {}): Promise<{ client: Client; stderr: string[] }> {
    const home = join(directory, "home"); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ general: { autoInitializeProjects: true } }));
    const launch = join(directory, "launch");
    mkdirSync(launch, { recursive: true });
    const client = new Client({ name: "unbound-test", version: "1" }, options.roots ? { capabilities: { roots: { listChanged: true } } } : {});
    let roots = options.roots ?? [];
    if (options.roots) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map(root => ({ uri: pathToFileURL(root).href })) }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, join(repository, "src", "cli.ts"), "mcp"],
      cwd: launch,
      env: { ...process.env as Record<string, string>, CODE_BUTLER_HOME: join(directory, "home"), CODE_BUTLER_PROJECT_ROOT: "" },
      stderr: "pipe"
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", data => stderr.push(String(data)));
    await client.connect(transport);
    clients.push(client);
    Object.assign(client, { setRoots: (next: string[]) => { roots = next; } });
    return { client, stderr };
  }

  const json = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

  it("connects, lists every tool, and explains how to bind a project", async () => {
    directory = makeTempDir();
    const { client } = await connect();
    expect(client.getInstructions()).toContain("projectRoot");
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("find_memories");
    expect(tools.tools.find(tool => tool.name === "current_project")?.inputSchema.properties).toHaveProperty("projectRoot");

    expect(json(await client.callTool({ name: "current_project", arguments: {} }))).toMatchObject({ bound: false, hint: expect.stringContaining("projectRoot") });
    const blocked = await client.callTool({ name: "find_memories", arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("no_project");
  }, 60_000);

  it("binds the Git repository containing the agent's working directory", async () => {
    directory = makeTempDir();
    const root = gitRepo("repo");
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const { client } = await connect();

    const relative = await client.callTool({ name: "current_project", arguments: { projectRoot: "repo" } });
    expect(relative.isError).toBe(true);
    expect(text(relative)).toContain("absolute path");
    const outside = await client.callTool({ name: "current_project", arguments: { projectRoot: join(directory, "launch") } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain("No Git repository contains");

    expect(json(await client.callTool({ name: "current_project", arguments: { projectRoot: nested } }))).toMatchObject({ rootDir: root, configCreated: true });
    expect(existsSync(join(root, ".code-butler", "memory.sqlite"))).toBe(true);
    const memories = await client.callTool({ name: "find_memories", arguments: {} });
    expect(memories.isError).toBeFalsy();
    expect(json(memories)).toHaveProperty("results");

    // A later agent in another repository may move an agent-chosen binding.
    const other = gitRepo("other");
    expect(json(await client.callTool({ name: "current_project", arguments: { projectRoot: other } }))).toMatchObject({ rootDir: other });
  }, 90_000);

  it("binds from client roots and follows roots changes", async () => {
    directory = makeTempDir();
    const first = gitRepo("first");
    const second = gitRepo("second");
    const { client } = await connect({ roots: [join(directory, "not-a-repo"), first] });

    await vi.waitFor(async () => expect(json(await client.callTool({ name: "current_project", arguments: {} }))).toMatchObject({ rootDir: first }), { timeout: 30_000, interval: 250 });
    const conflicting = await client.callTool({ name: "current_project", arguments: { projectRoot: second } });
    expect(conflicting.isError).toBe(true);
    expect(text(conflicting)).toContain(`This connection serves ${first}`);

    (client as Client & { setRoots(next: string[]): void }).setRoots([second]);
    await client.sendRootsListChanged();
    await vi.waitFor(async () => expect(json(await client.callTool({ name: "current_project", arguments: {} }))).toMatchObject({ rootDir: second }), { timeout: 30_000, interval: 250 });
  }, 90_000);
});
