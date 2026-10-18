import { binding, readJson } from "./cloud/state.js";
import { buildRulesCatalog, getApplicableRules, GLOBAL_RULES_INSTRUCTIONS } from "./rules/match.js";
import { recordAttestation, type RecordAttestationInput } from "./rules/attestations.js";
import { retrievalEnabled } from "./retrieval/paths.js";
import { createPublishedMemoryServer } from "./retrieval/mcp.js";
import { localCloudChangeStamp, projectOperation, startCloudScheduler, type CloudScheduler } from "./cloud/client.js";
import { automaticSyncStatus, requestLocalChangeSync } from "./cloud/sync-owner.js";
import { buildInfo, newRuntimeRecord, registerRuntime } from "./runtime.js";
import { createProjectMemoryToolHandlers, registerProjectMemoryHandlers, readCurrentProjectInfo, type ProjectMemoryToolHandlers } from "./mcp/tools.js";
import { ensureAutomaticProjectSetup, enrichLocalProjectSummary, readProjectSetupStatus, validateProjectSetupPaths, type AutomaticSetupOptions } from "./project-setup.js";
import { readAgentContext } from "./project-summary/agent-guidance.js";
import { readProjectBrief } from "./project-summary/service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { globalConfigDir, loadProjectConfig } from "./config.js";
import type { ProjectStartupMetadata } from "./mcp/tools.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";
import { MemoryStoreCheckpointBusyError, type MemoryStore } from "./storage/store.js";
import { syncProjectMemory } from "./sync/service.js";
import { registerWatchedProject } from "./global-watch.js";
import { queueAutomaticConnection } from "./cloud/auto-connect.js";

export interface ProjectMemoryServer {
  server: McpServer;
  store: MemoryStore;
  cloudManaged?: boolean;
  stopCloud?: CloudScheduler;
  drain?: () => Promise<void>;
  resume?: () => void;
  unregisterRuntime?: () => void;
  /** Present only when the caller asked to defer startup sync; see startServer. */
  startupSync?: () => Promise<void>;
}

export interface ProjectMemoryServerOptions {
  rootDir?: string;
  cloudSchedulerOptions?: Parameters<typeof startCloudScheduler>[2];
  startupMetadata?: ProjectStartupMetadata;
  /**
   * Return before the startup sync runs, handing it back as `startupSync`.
   * A stdio client closes the pipe if `initialize` goes unanswered past its
   * timeout, and startup sync is long synchronous SQLite work, so the transport
   * has to be connected and the handshake answered before it begins.
   */
  deferStartupSync?: boolean;
  autoInit?: boolean;
  setupOptions?: AutomaticSetupOptions;
}

class RecoverableProjectMemoryShutdownError extends Error {}

/** Fallback delay for clients that connect but never send `initialized`. */
const STARTUP_SYNC_FALLBACK_MS = 5_000;

const shutdowns = new WeakMap<ProjectMemoryServer, Promise<void>>();
export function closeProjectMemoryServer(projectServer: ProjectMemoryServer): Promise<void> {
  const existing = shutdowns.get(projectServer);
  if (existing) return existing;
  const shutdown = closeServer(projectServer).catch(error => { shutdowns.delete(projectServer); throw error; });
  shutdowns.set(projectServer, shutdown); return shutdown;
}
async function closeServer(projectServer: ProjectMemoryServer): Promise<void> {
  try {
    const stop = projectServer.stopCloud?.();
    await projectServer.drain?.();
    await stop;
    if (!projectServer.cloudManaged) projectServer.store.close();
  } catch (error) {
    if (error instanceof MemoryStoreCheckpointBusyError) {
      projectServer.resume?.();
      throw new RecoverableProjectMemoryShutdownError(error.message);
    }
    throw new Error(
      "Memory database close failed before MCP transport shutdown: " +
      (error instanceof Error ? error.message : String(error))
    );
  }
  try {
    await projectServer.server.close();
    projectServer.unregisterRuntime?.();
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
  // Keep pre-handshake checks limited to storage; bad visible artifacts are reported by post-handshake setup.
  validateProjectSetupPaths(rootDir, false);
  if(retrievalEnabled()) return createPublishedMemoryServer(rootDir,options);
  const pending = new Set<Promise<unknown>>();
  const setupAbort = new AbortController();
  const setupOptions = { ...options.setupOptions, signal: setupAbort.signal };
  let enrichmentTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const track = <T>(work: () => Promise<T> | T): Promise<T> => {
    if (closing) return Promise.reject(new Error("MCP server is shutting down"));
    const promise = Promise.resolve().then(work);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const drain = async (): Promise<void> => { closing = true; clearInterval(enrichmentTimer); setupAbort.abort(); await Promise.allSettled([...pending]); };
  const enrich = () => {
    if (closing || readProjectSetupStatus(rootDir).summaryQuality !== "local") return;
    void track(() => enrichLocalProjectSummary(rootDir, setupOptions)).catch(error => {
      if (!setupAbort.signal.aborted) console.error(`Code Butler summary enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const runStartup = async (sync: () => Promise<void>): Promise<void> => {
    if (options.autoInit !== false) {
      try {
        const setup = await ensureAutomaticProjectSetup(rootDir, setupOptions);
        console.error(`Code Butler project setup ${setup.status}: ${rootDir}`);
        if (setup.backupFiles.length) console.error(`Agent instruction backups: ${setup.backupFiles.join(", ")}`);
      } catch (error) {
        console.error(`Code Butler project setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try { await sync(); }
    finally {
      if (options.autoInit !== false && !closing && readProjectSetupStatus(rootDir).status === "ready") {
        enrich();
        if (!enrichmentTimer) { enrichmentTimer = setInterval(enrich, 60_000); enrichmentTimer.unref(); }
      }
    }
  };
  const startupMetadata = options.startupMetadata ?? {
    configCreated: !existsSync(join(rootDir, ".code-butler", "config.json")),
    databaseCreated: !existsSync(join(rootDir, ".code-butler", "memory.sqlite"))
  };
  if (binding(rootDir)?.enabled) {
    const runCloudStartupSync = async (): Promise<void> => runStartup(async () => {
      await projectOperation(rootDir, async () => {
        const bootstrap = openConfiguredMemoryStore(rootDir);
        try {
          bootstrap.init();
          const config = loadProjectConfig(rootDir);
          if (config.sync.autoSyncOnServerStart) await syncProjectMemory(bootstrap, config);
        } finally { bootstrap.close(); }
      }, { name: "MCP startup sync" });
      if (automaticSyncStatus(rootDir).lastLocalStamp !== localCloudChangeStamp(rootDir)) requestLocalChangeSync(rootDir);
    });
    if (!options.deferStartupSync) await runCloudStartupSync();
    // Handlers open their own store per call, so this handle only has to exist
    // and carry a current schema; opening and closing it takes no network.
    const store = await projectOperation(rootDir, async () => {
      const bootstrap = openConfiguredMemoryStore(rootDir);
      try {
        bootstrap.init();
        return bootstrap;
      } finally { bootstrap.close(); }
    });
    const server = new McpServer({ name: "project-memory", version: buildInfo.version }, { instructions: GLOBAL_RULES_INSTRUCTIONS });
    const handlers = new Proxy({} as ProjectMemoryToolHandlers, {
      get(_target, name) {
        if (name === "current_project") return () => track(() => readCurrentProjectInfo(rootDir, startupMetadata));
        if (name === "get_applicable_rules") return (input: import("./rules/match.js").RuleQuery) => track(() => getApplicableRules(rootDir, input));
        if (name === "record_rule_attestation") return (input: RecordAttestationInput) => track(() => recordAttestation(input, { by: "agent", projectRoot: rootDir }));
        if (name === "summarize_project_brief") return () => track(() => ({ ...readProjectBrief(rootDir), ...readAgentContext(rootDir), setup: readProjectSetupStatus(rootDir), globalRules: buildRulesCatalog(rootDir) }));
        return (...args: unknown[]) => track(() => projectOperation(rootDir, async () => {
          const current = openConfiguredMemoryStore(rootDir);
          try {
            current.init();
            const live = createProjectMemoryToolHandlers(current, { rootDir, startupMetadata, clientInfo: () => server.server.getClientVersion() });
            const handler = Reflect.get(live, name) as (...values: unknown[]) => unknown;
            return await handler(...args);
          } finally { current.close(); }
        }, { name: name === "syncProjectMemory" ? "Memory sync" : `MCP ${String(name)}` }));
      }
    });
    registerProjectMemoryHandlers(server, handlers);
    return {
      server,
      store,
      cloudManaged: true,
      drain,
      stopCloud: startCloudScheduler(rootDir, console.error, options.cloudSchedulerOptions),
      ...(options.deferStartupSync ? { startupSync: () => track(runCloudStartupSync) } : {})
    };
  }
  const store = openConfiguredMemoryStore(rootDir);
  store.init();
  const config = loadProjectConfig(rootDir);
  const runStartupSync = async (): Promise<void> => runStartup(async () => {
    if (config.sync.autoSyncOnServerStart) await syncProjectMemory(store, config);
  });
  if (!options.deferStartupSync) await runStartupSync();
  const server = new McpServer({
    name: "project-memory",
    version: buildInfo.version
  }, { instructions: GLOBAL_RULES_INSTRUCTIONS });
  const handlers = createProjectMemoryToolHandlers(store, { rootDir, startupMetadata, clientInfo: () => server.server.getClientVersion() });
  registerProjectMemoryHandlers(server, new Proxy(handlers, { get(target, name) {
    const handler = Reflect.get(target, name) as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => track(() => handler(...args));
  } }));
  return {
    server,
    store,
    drain,
    resume: () => { closing = false; },
    ...(options.deferStartupSync ? { startupSync: () => track(runStartupSync) } : {})
  };
}

export async function startServer(options: ProjectMemoryServerOptions = {}): Promise<ProjectMemoryServer> {
  const projectServer = await createProjectMemoryServer({ ...options, deferStartupSync: true });
  const transport = new StdioServerTransport();
  const runtime = newRuntimeRecord("mcp", options.rootDir ?? process.cwd());
  projectServer.unregisterRuntime = registerRuntime(runtime);
  let closing = false;
  let fallback: NodeJS.Timeout | undefined;
  const startupSync = projectServer.startupSync;
  // Startup sync is long synchronous SQLite work that blocks the event loop, so
  // it waits for the client handshake. Answering `initialize` first is what stops
  // the client from timing out, closing the pipe, and leaving this process orphaned.
  if (startupSync) {
    let started = false;
    const runStartupSyncOnce = (): void => {
      if (started || closing) return;
      started = true;
      clearTimeout(fallback);
      void startupSync().catch((error) => {
        console.error(
          "Code Butler startup sync failed; the server keeps serving stored memory: " +
          (error instanceof Error ? error.message : String(error))
        );
      });
    };
    // A client that never sends `initialized` must still get its startup sync.
    fallback = setTimeout(runStartupSyncOnce, STARTUP_SYNC_FALLBACK_MS);
    fallback.unref();
    projectServer.server.server.oninitialized = () => {
      // Yield so the SDK finishes the handshake before sync blocks the loop.
      setTimeout(runStartupSyncOnce, 0);
    };
  }
  await projectServer.server.connect(transport);
  try {
    queueAutomaticConnection(registerWatchedProject(options.rootDir ?? process.cwd()).root);
  } catch (error) {
    console.error(`Global watcher registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.error("Project Memory MCP Server running on stdio");

  const close = (): Promise<void> => {
    closing = true; clearTimeout(fallback);
    return closeProjectMemoryServer(projectServer);
  };
  const handleSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    void close().then(
      () => process.exit(0),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RecoverableProjectMemoryShutdownError) {
          closing = false;
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
  const handoffTimer = setInterval(() => {
    if (closing) return;
    const request = readJson<{ token: string }>(join(globalConfigDir(), "runtime-stop", `${runtime.token}.json`));
    if (request?.token === runtime.token) handleSignal("SIGTERM");
  }, 1000);
  handoffTimer.unref();
  const unregisterOnClose = projectServer.unregisterRuntime;
  projectServer.unregisterRuntime = () => { clearInterval(handoffTimer); unregisterOnClose?.(); };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  const disconnected = (): void => {
    if (closing) return;
    void close().then(() => process.exit(0), error => {
      console.error(`Code Butler disconnect cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", disconnected);
  process.stdin.once("close", disconnected);
  projectServer.server.server.onclose = disconnected;

  return projectServer;
}

// A bundled CLI also contains this module; URL equality alone would mistake
// its bundle for the standalone MCP server entry point.
if (/^server\.(?:js|ts)$/.test(basename(fileURLToPath(import.meta.url)))
    && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
