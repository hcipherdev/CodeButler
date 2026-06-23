import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectConfig } from "./config.js";
import { registerProjectMemoryTools, type ProjectStartupMetadata } from "./mcp/tools.js";
import { openMemoryStore } from "./storage/store.js";
import { syncProjectMemory } from "./sync/service.js";

export interface ProjectMemoryServer {
  server: McpServer;
  store: ReturnType<typeof openMemoryStore>;
}

export interface ProjectMemoryServerOptions {
  rootDir?: string;
  startupMetadata?: ProjectStartupMetadata;
}

export async function createProjectMemoryServer(
  rootDirOrOptions: string | ProjectMemoryServerOptions = process.cwd()
): Promise<ProjectMemoryServer> {
  const options = typeof rootDirOrOptions === "string" ? { rootDir: rootDirOrOptions } : rootDirOrOptions;
  const rootDir = options.rootDir ?? process.cwd();
  const startupMetadata = options.startupMetadata ?? {
    configCreated: !existsSync(join(rootDir, ".code-butler", "config.json")),
    databaseCreated: !existsSync(join(rootDir, ".code-butler", "memory.sqlite"))
  };
  const store = openMemoryStore(rootDir);
  store.init();
  const config = loadProjectConfig(rootDir);
  if (config.sync.autoSyncOnServerStart) {
    await syncProjectMemory(store, config);
  }
  const server = new McpServer({
    name: "project-memory",
    version: "0.1.0"
  });
  registerProjectMemoryTools(server, store, { rootDir, startupMetadata });
  return { server, store };
}

export async function startServer(options: ProjectMemoryServerOptions = {}): Promise<ProjectMemoryServer> {
  const projectServer = await createProjectMemoryServer(options);
  const transport = new StdioServerTransport();
  await projectServer.server.connect(transport);
  console.error("Project Memory MCP Server running on stdio");

  const close = async (): Promise<void> => {
    await projectServer.server.close();
    projectServer.store.close();
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  return projectServer;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
