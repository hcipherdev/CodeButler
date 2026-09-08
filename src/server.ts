import { binding } from "./cloud/state.js";
import { projectOperation, startCloudScheduler, syncQuietly } from "./cloud/client.js";
import { createProjectMemoryToolHandlers, registerProjectMemoryHandlers, type ProjectMemoryToolHandlers } from "./mcp/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectConfig } from "./config.js";
import { registerProjectMemoryTools, type ProjectStartupMetadata } from "./mcp/tools.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";
import { MemoryStoreCheckpointBusyError, type MemoryStore } from "./storage/store.js";
import { syncProjectMemory } from "./sync/service.js";

export interface ProjectMemoryServer {
  server: McpServer;
  store: MemoryStore;
  cloudManaged?: boolean;
  stopCloud?: () => void;
}

export interface ProjectMemoryServerOptions {
  rootDir?: string;
  startupMetadata?: ProjectStartupMetadata;
}

class RecoverableProjectMemoryShutdownError extends Error {}

export async function closeProjectMemoryServer(projectServer: ProjectMemoryServer): Promise<void> {
  try {
    projectServer.stopCloud?.();
    if (!projectServer.cloudManaged) projectServer.store.close();
  } catch (error) {
    if (error instanceof MemoryStoreCheckpointBusyError) {
      throw new RecoverableProjectMemoryShutdownError(error.message);
    }
    throw new Error(
      "Memory database close failed before MCP transport shutdown: " +
      (error instanceof Error ? error.message : String(error))
    );
  }
  try {
    await projectServer.server.close();
  } catch (error) {
    throw new Error(
      "MCP server close failed after the memory database was safely closed: " +
      (error instanceof Error ? error.message : String(error))
    );
  }
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
  if (binding(rootDir)?.enabled) {
    await syncQuietly(rootDir);
    const store = await projectOperation(rootDir, async () => {
      const bootstrap = openConfiguredMemoryStore(rootDir);
      try {
        bootstrap.init();
        const config = loadProjectConfig(rootDir);
        if (config.sync.autoSyncOnServerStart) await syncProjectMemory(bootstrap, config);
        return bootstrap;
      } finally { bootstrap.close(); }
    });
    const server = new McpServer({ name: "project-memory", version: "0.1.0" });
    const handlers = new Proxy({} as ProjectMemoryToolHandlers, {
      get(_target, name) {
        return (...args: unknown[]) => projectOperation(rootDir, async () => {
          const current = openConfiguredMemoryStore(rootDir);
          try {
            current.init();
            const live = createProjectMemoryToolHandlers(current, { rootDir, startupMetadata, clientInfo: () => server.server.getClientVersion() });
            const handler = Reflect.get(live, name) as (...values: unknown[]) => unknown;
            return await handler(...args);
          } finally { current.close(); }
        });
      }
    });
    registerProjectMemoryHandlers(server, handlers);
    return { server, store, cloudManaged: true, stopCloud: startCloudScheduler(rootDir) };
  }
  const store = openConfiguredMemoryStore(rootDir);
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

  const close = (): Promise<void> => closeProjectMemoryServer(projectServer);
  const handleSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    void close().then(
      () => process.exit(0),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RecoverableProjectMemoryShutdownError) {
          console.error(
            `Code Butler ${signal} shutdown was cancelled: ${message} ` +
            "The server remains running; close other SQLite readers and signal again before syncing this project."
          );
          process.exitCode = 1;
          return;
        }
        console.error(
          `Code Butler ${signal} shutdown failed after closing the memory database: ${message}. Terminating.`
        );
        process.exit(1);
      }
    );
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  return projectServer;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
