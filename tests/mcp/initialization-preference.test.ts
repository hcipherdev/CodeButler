// Tests real MCP connections leave new projects untouched by default and obey the persisted desktop opt-in.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { createProjectMemoryServer } from "../../src/server.js";
import { createPublishedMemoryServer } from "../../src/retrieval/mcp.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const repository = process.cwd();
const loader = pathToFileURL(join(repository, "node_modules/tsx/dist/loader.mjs")).href;
const json = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

describe("MCP automatic initialization preference", () => {
  let directory: string;
  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.unstubAllEnvs(); cleanupTempDir(directory);
  });

  it.each(["legacy", "published"].flatMap(engine => ["launch", "roots", "agent"].map(source => ({ engine, source }))))(
    "keeps a new project untouched through $source with the $engine engine until enabled",
    async ({ engine, source }) => {
      directory = makeTempDir();
      const root = join(directory, "project"); mkdirSync(root);
      execFileSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, "AGENTS.md"), "My instructions\n");
      const before = readdirSync(root).sort();
      const home = join(directory, "home"); mkdirSync(home);
      // No preference in an old config must also default off.
      writeFileSync(join(home, "config.json"), JSON.stringify({ sources: { codex: { enabled: false }, claude: { enabled: false } }, extractor: { enabled: false }, investigator: { enabled: false } }));
      vi.stubEnv("CODE_BUTLER_HOME", home);
      vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", engine);
      const launch = join(directory, "launch"); mkdirSync(launch);
      const client = new Client({ name: "preference-test", version: "1" }, source === "roots" ? { capabilities: { roots: { listChanged: true } } } : {});
      if (source === "roots") client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(root).href }] }));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", loader, join(repository, "src/cli.ts"), "mcp"],
        cwd: source === "launch" ? root : launch,
        env: { ...process.env as Record<string, string>, CODE_BUTLER_PROJECT_ROOT: "", CODE_BUTLER_RETRIEVAL_ENGINE: engine },
        stderr: "pipe"
      });
      clients.push(client); await client.connect(transport);
      expect((await client.listTools()).tools.some(tool => tool.name === "current_project")).toBe(true);
      const args = source === "agent" ? { projectRoot: root } : {};
      await vi.waitFor(async () => expect(json(await client.callTool({ name: "current_project", arguments: args }))).toMatchObject({ bound: false, rootDir: root, hint: expect.stringContaining("Settings > General") }), { timeout: 10_000 });
      const blocked = await client.callTool({ name: "find_memories", arguments: {} });
      expect(blocked.isError).toBe(true);
      expect((blocked.content as Array<{ text: string }>)[0]!.text).toContain("automatic project initialization is disabled");
      expect(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("My instructions\n");
      expect(existsSync(join(home, "watch/projects"))).toBe(false);

      // A running connection picks up the desktop setting without rewriting client registrations.
      await handleDesktopRequest({ version: 1, action: "settings.general.save", settings: { autoInitializeProjects: true } });
      expect(json(await client.callTool({ name: "current_project", arguments: {} }))).toMatchObject({ rootDir: root });
      await vi.waitFor(async () => expect(json(await client.callTool({ name: "current_project", arguments: {} }))).toMatchObject({ setup: { status: "ready" } }), { timeout: 15_000 });
      expect(existsSync(join(root, ".code-butler/memory.sqlite"))).toBe(true);
      expect(readdirSync(join(home, "watch/projects"))).toHaveLength(1);

      // Disabling it again keeps already initialized projects usable on reconnect.
      await client.close(); clients.splice(clients.indexOf(client), 1);
      await handleDesktopRequest({ version: 1, action: "settings.general.save", settings: { autoInitializeProjects: false } });
      const existing = await createProjectMemoryServer({ rootDir: root, deferStartupSync: true, cloudSchedulerOptions: { automatic: false } });
      try { expect(await existing.handlers!.current_project()).toMatchObject({ rootDir: root }); }
      finally { await (await import("../../src/server.js")).closeProjectMemoryServer(existing); }
    }, 45_000
  );

  it("also guards direct server constructors before creating storage", async () => {
    directory = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
    const root = join(directory, "project"); mkdirSync(root);
    await expect(createProjectMemoryServer(root)).rejects.toThrow("automatic project initialization is disabled");
    await expect(createPublishedMemoryServer(root, {})).rejects.toThrow("automatic project initialization is disabled");
    expect(readdirSync(root)).toEqual([]);
  });
});
