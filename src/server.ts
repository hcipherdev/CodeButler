import { binding, readJson } from "./cloud/state.js";
import { withAiTrigger } from "./ai/usage.js";
import { buildRulesCatalog, getApplicableRules, GLOBAL_RULES_INSTRUCTIONS } from "./rules/match.js";
import { recordAttestation, type RecordAttestationInput } from "./rules/attestations.js";
import { retrievalEnabled } from "./retrieval/paths.js";
import { createPublishedMemoryServer } from "./retrieval/mcp.js";
import { localCloudChangeStamp, projectOperation, startCloudScheduler, type CloudScheduler } from "./cloud/client.js";
import { releaseProjectGateDuring } from "./cloud/gate.js";
import { automaticSyncStatus, requestLocalChangeSync } from "./cloud/sync-owner.js";
import { buildInfo, newRuntimeRecord, registerRuntime } from "./runtime.js";
import { createProjectMemoryToolHandlers, projectTrustInfo, registerProjectMemoryHandlers, readCurrentProjectInfo, type ProjectMemoryToolHandlers } from "./mcp/tools.js";
import { ensureAutomaticProjectSetup, enrichLocalProjectSummary, readProjectSetupStatus, validateProjectSetupPaths, type AutomaticSetupOptions } from "./project-setup.js";
import { readAgentContext } from "./project-summary/agent-guidance.js";
import { readProjectBrief } from "./project-summary/service.js";
import { agentProjectRoot, assertMcpProjectAvailable, automaticProjectInitializationEnabled, gitRootFor, NO_PROJECT_HINT, NoProjectError, prepareMcpProject, ProjectInitializationDisabledError, PROJECT_INITIALIZATION_HINT, type ProjectBindingSource, type UnboundProjectInfo } from "./mcp/project-binding.js";
import type { CurrentProjectInfo } from "./mcp/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { globalConfigDir, loadProjectConfig } from "./config.js";
import type { ProjectStartupMetadata } from "./mcp/tools.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";
import { MemoryStoreCheckpointBusyError, type MemoryStore } from "./storage/store.js";
import { syncProjectMemory, syncWatchedProjectMemory } from "./sync/service.js";
import { globalWatcherManages, registerWatchedProject } from "./global-watch.js";
import { OperationDeferredError } from "./cloud/outcome.js";
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
  /** The registered tool handlers, so one connected server can route to this project. */
  handlers?: ProjectMemoryToolHandlers;
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
  /** The connected client's identity when this project is served through another server's transport. */
  clientInfo?: () => { name: string; version: string } | undefined;
}

class RecoverableProjectMemoryShutdownError extends Error {}

/** A startup sync would only repeat the running watcher's next pass, and compete with it for the project lock. */
function startupSyncLeftToWatcher(rootDir: string): boolean {
  if (!globalWatcherManages(rootDir)) return false;
  console.error("Code Butler startup sync left to the background watcher");
  return true;
}

/** Fallback delay for clients that connect but never send `initialized`. */
const STARTUP_SYNC_FALLBACK_MS = 5_000;
/** A client that advertises roots but never answers must not hold the connection unbound for long. */
const ROOTS_TIMEOUT_MS = 5_000;
const PROJECT_BINDING_INSTRUCTIONS = `If current_project reports no project, or a tool fails with no_project, ${NO_PROJECT_HINT[0]!.toLowerCase()}${NO_PROJECT_HINT.slice(1)}`;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
  assertMcpProjectAvailable(rootDir, options.autoInit);
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
    if (automaticProjectInitializationEnabled(options.autoInit)) {
      try {
        const setup = await ensureAutomaticProjectSetup(rootDir, setupOptions);
        console.error(`Code Butler project setup ${setup.status}: ${rootDir}`);
        if (setup.backupFiles.length) console.error(`Agent instruction backups: ${setup.backupFiles.join(", ")}`);
      } catch (error) {
        console.error(`Code Butler project setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const trust = projectTrustInfo(rootDir);
    if (trust?.status === "untrusted") {
      console.error(`Code Butler ignores this repository's own settings until approved on this device: ${trust.ignored.join(", ")}. Review with: code-butler config trust status`);
    }
    try { await sync(); }
    finally {
      if (automaticProjectInitializationEnabled(options.autoInit) && !closing && readProjectSetupStatus(rootDir).status === "ready") {
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
      if (startupSyncLeftToWatcher(rootDir)) return;
      const config = loadProjectConfig(rootDir);
      // The watcher's pass holds the project lock only around database steps, so another
      // server starting meanwhile, or a tool call, is not shut out for the whole sync.
      if (config.sync.autoSyncOnServerStart) await withAiTrigger("background", () => syncWatchedProjectMemory(rootDir, config));
      if (automaticSyncStatus(rootDir).lastLocalStamp !== localCloudChangeStamp(rootDir)) requestLocalChangeSync(rootDir);
    });
    if (!options.deferStartupSync) await runCloudStartupSync();
    // Handlers open and migrate their own store per call. Checking the schema now is a courtesy
    // that waits briefly at most: this runs before the client's handshake, and while another
    // operation holds the lock even opening the database is refused.
    try {
      await projectOperation(rootDir, () => {
        const bootstrap = openConfiguredMemoryStore(rootDir);
        try { bootstrap.init(); } finally { bootstrap.close(); }
      }, { waitMs: 1_000, background: true, name: "MCP startup schema check" });
    } catch (error) {
      if (!(error instanceof OperationDeferredError)) throw error;
      console.error("Code Butler is busy with another operation on this project; the first tool call checks the schema");
    }
    // Only programmatic inspection reads this handle, so it opens on first use rather than at startup.
    let inspectionStore: MemoryStore | undefined;
    const server = new McpServer({ name: "project-memory", version: buildInfo.version }, { instructions: GLOBAL_RULES_INSTRUCTIONS });
    const handlers = new Proxy({} as ProjectMemoryToolHandlers, {
      get(_target, name) {
        if (name === "current_project") return () => track(() => readCurrentProjectInfo(rootDir, startupMetadata));
        if (name === "get_applicable_rules") return (input: import("./rules/match.js").RuleQuery) => track(() => getApplicableRules(rootDir, input));
        if (name === "record_rule_attestation") return (input: RecordAttestationInput) => track(() => recordAttestation(input, { by: "agent", projectRoot: rootDir }));
        if (name === "summarize_project_brief") return () => track(() => {
          const trust = projectTrustInfo(rootDir);
          return { ...readProjectBrief(rootDir), ...readAgentContext(rootDir), setup: readProjectSetupStatus(rootDir), globalRules: buildRulesCatalog(rootDir), ...(trust ? { trust } : {}) };
        });
        return (...args: unknown[]) => track(() => projectOperation(rootDir, async () => {
          const current = openConfiguredMemoryStore(rootDir);
          try {
            current.init();
            const live = createProjectMemoryToolHandlers(current, { rootDir, startupMetadata, clientInfo: options.clientInfo ?? (() => server.server.getClientVersion()),
              // Model calls can take minutes; other local work may use the project meanwhile.
              aroundModelCall: call => releaseProjectGateDuring(rootDir, call) });
            const handler = Reflect.get(live, name) as (...values: unknown[]) => unknown;
            return await handler(...args);
          } finally { current.close(); }
        }, { name: name === "syncProjectMemory" ? "Memory sync" : `MCP ${String(name)}` }));
      }
    });
    registerProjectMemoryHandlers(server, handlers);
    return {
      server,
      get store() {
        if (!inspectionStore) { inspectionStore = openConfiguredMemoryStore(rootDir); inspectionStore.init(); }
        return inspectionStore;
      },
      handlers,
      cloudManaged: true,
      drain: async () => { await drain(); inspectionStore?.close(); },
      stopCloud: startCloudScheduler(rootDir, console.error, options.cloudSchedulerOptions),
      ...(options.deferStartupSync ? { startupSync: () => track(runCloudStartupSync) } : {})
    };
  }
  const store = openConfiguredMemoryStore(rootDir);
  store.init();
  const config = loadProjectConfig(rootDir);
  const runStartupSync = async (): Promise<void> => runStartup(async () => {
    if (startupSyncLeftToWatcher(rootDir)) return;
    if (config.sync.autoSyncOnServerStart) await withAiTrigger("background", () => syncProjectMemory(store, config));
  });
  if (!options.deferStartupSync) await runStartupSync();
  const server = new McpServer({
    name: "project-memory",
    version: buildInfo.version
  }, { instructions: GLOBAL_RULES_INSTRUCTIONS });
  const handlers = new Proxy(createProjectMemoryToolHandlers(store, { rootDir, startupMetadata, clientInfo: options.clientInfo ?? (() => server.server.getClientVersion()) }), { get(target, name) {
    const handler = Reflect.get(target, name) as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => track(() => handler(...args));
  } });
  registerProjectMemoryHandlers(server, handlers);
  return {
    server,
    store,
    handlers,
    drain,
    resume: () => { closing = false; },
    ...(options.deferStartupSync ? { startupSync: () => track(runStartupSync) } : {})
  };
}

/**
 * Serve MCP on stdio. A project resolved at launch is bound before the handshake.
 * Otherwise the connection stays up without one and binds the first Git repository
 * among the client's roots, or the working directory the agent passes to
 * current_project, so a globally registered server works from any launch folder.
 */
export async function startServer(options: ProjectMemoryServerOptions = {}): Promise<void> {
  const server = new McpServer({ name: "project-memory", version: buildInfo.version }, { instructions: `${GLOBAL_RULES_INSTRUCTIONS} ${PROJECT_BINDING_INSTRUCTIONS}` });
  const transport = new StdioServerTransport();
  const runtime = newRuntimeRecord("mcp", options.rootDir);
  let unregisterRuntime = registerRuntime(runtime);
  let session: { project: ProjectMemoryServer; root: string; source: ProjectBindingSource; synced: boolean } | undefined;
  let pendingProject: { root: string; source: ProjectBindingSource } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let initialized = false;
  let fallback: NodeJS.Timeout | undefined;
  let shutdown: Promise<void> | undefined;

  // Binding, switching and closing replace the session, so they run one at a time.
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  // Startup sync is long synchronous SQLite work that blocks the event loop, so
  // it waits for the client handshake. Answering `initialize` first is what stops
  // the client from timing out, closing the pipe, and leaving this process orphaned.
  const runStartupSync = (): void => {
    const current = session;
    if (!current || current.synced || closing || !current.project.startupSync) return;
    current.synced = true;
    void current.project.startupSync().catch((error) => {
      console.error(`Code Butler startup sync failed; the server keeps serving stored memory: ${errorMessage(error)}`);
    });
  };
  const bindNow = async (root: string, source: ProjectBindingSource, startupMetadata?: ProjectStartupMetadata) => {
    if (session?.root === root) return session;
    if (closing) throw new Error("MCP server is shutting down");
    // A disabled new project stays unbound, with the transport available to explain how to opt in.
    try { assertMcpProjectAvailable(root, options.autoInit); }
    catch (error) {
      if (!(error instanceof ProjectInitializationDisabledError)) throw error;
      if (session) { await closeProjectMemoryServer(session.project); session = undefined; }
      pendingProject = { root, source };
      console.error(error.message);
      return undefined;
    }
    const metadata = startupMetadata ?? await prepareMcpProject(root, options.autoInit);
    if (session) {
      await closeProjectMemoryServer(session.project);
      session = undefined;
    }
    const project = await createProjectMemoryServer({
      ...options, rootDir: root, startupMetadata: metadata, deferStartupSync: true,
      clientInfo: () => server.server.getClientVersion()
    });
    session = { project, root, source, synced: false };
    pendingProject = undefined;
    unregisterRuntime = registerRuntime({ ...runtime, project: root });
    try {
      queueAutomaticConnection(registerWatchedProject(root).root);
    } catch (error) {
      console.error(`Global watcher registration failed: ${errorMessage(error)}`);
    }
    if (source !== "launch") console.error(`Code Butler MCP is now serving ${root} (from ${source === "roots" ? "the client's roots" : "the agent's working directory"})`);
    // Yield so the SDK finishes any in-flight response before sync blocks the loop.
    if (initialized) setTimeout(runStartupSync, 0);
    return session;
  };
  const bindFromRoots = (): Promise<void> => serialize(async () => {
    const selected = session ?? pendingProject;
    if (closing || (selected && selected.source !== "roots") || !server.server.getClientCapabilities()?.roots) return;
    let roots: Array<{ uri: string }>;
    try {
      roots = (await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS })).roots;
    } catch (error) {
      console.error(`Code Butler could not read the client's roots: ${errorMessage(error)}`);
      return;
    }
    const root = roots.map(item => gitRootFor(item.uri)).find((value): value is string => value !== undefined);
    if (root) await bindNow(root, "roots");
    else if (!session) { pendingProject = undefined; console.error("None of the client's roots is inside a Git repository; waiting for current_project(projectRoot)."); }
  });
  const currentProject = (input: { projectRoot?: string | undefined } = {}) => serialize(async (): Promise<CurrentProjectInfo | UnboundProjectInfo> => {
    if (input.projectRoot) {
      const root = agentProjectRoot(input.projectRoot);
      const selected = session ?? pendingProject;
      if (selected && selected.root !== root && selected.source !== "agent") {
        const chosen = selected.source === "launch" ? "when the client started it" : "from the client's roots";
        throw new Error(`This connection serves ${selected.root}, chosen ${chosen}. Start the client from ${root} to use that project.`);
      }
      await bindNow(root, selected?.source ?? "agent");
    }
    else if (!session && pendingProject) await bindNow(pendingProject.root, pendingProject.source);
    if (!session) {
      if (pendingProject) return { bound: false, rootDir: pendingProject.root, reason: "Project memory is not initialized and automatic project initialization is disabled.", hint: PROJECT_INITIALIZATION_HINT };
      return { bound: false, reason: "The client started Code Butler outside a Git repository and reported no workspace folder inside one.", hint: NO_PROJECT_HINT };
    }
    return await session.project.handlers!.current_project();
  });
  const handlers = new Proxy({} as ProjectMemoryToolHandlers, {
    get(_target, name) {
      if (name === "current_project") return currentProject;
      return async (...args: unknown[]) => {
        await queue;
        if (!session) {
          if (pendingProject) throw new ProjectInitializationDisabledError(pendingProject.root);
          throw new NoProjectError();
        }
        const handler = Reflect.get(session.project.handlers!, name) as (...values: unknown[]) => unknown;
        return await handler(...args);
      };
    }
  });
  registerProjectMemoryHandlers(server, handlers);

  if (options.rootDir) await serialize(() => bindNow(options.rootDir!, "launch", options.startupMetadata));
  const markInitialized = (): void => {
    if (initialized) return;
    initialized = true;
    clearTimeout(fallback);
    setTimeout(runStartupSync, 0);
  };
  // A client that never sends `initialized` must still get its startup sync.
  fallback = setTimeout(markInitialized, STARTUP_SYNC_FALLBACK_MS);
  fallback.unref();
  server.server.oninitialized = () => {
    markInitialized();
    if (!session) void bindFromRoots().catch(error => console.error(`Code Butler could not bind the client's roots: ${errorMessage(error)}`));
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    void bindFromRoots().catch(error => console.error(`Code Butler could not bind the client's roots: ${errorMessage(error)}`));
  });
  await server.connect(transport);
  console.error("Project Memory MCP Server running on stdio");

  const handoffTimer = setInterval(() => {
    if (closing) return;
    const request = readJson<{ token: string }>(join(globalConfigDir(), "runtime-stop", `${runtime.token}.json`));
    if (request?.token === runtime.token) handleSignal("SIGTERM");
  }, 1000);
  handoffTimer.unref();
  const close = (): Promise<void> => {
    closing = true; clearTimeout(fallback);
    shutdown ??= serialize(async () => {
      if (session) await closeProjectMemoryServer(session.project);
      try {
        await server.close();
      } catch (error) {
        throw new Error(`MCP server close failed after the memory database was safely closed: ${errorMessage(error)}`);
      }
      clearInterval(handoffTimer);
      unregisterRuntime();
    }).catch(error => { shutdown = undefined; throw error; });
    return shutdown;
  };
  function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    void close().then(
      () => process.exit(0),
      (error) => {
        const message = errorMessage(error);
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
  }
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  const disconnected = (): void => {
    if (closing) return;
    void close().then(() => process.exit(0), error => {
      console.error(`Code Butler disconnect cleanup failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", disconnected);
  process.stdin.once("close", disconnected);
  server.server.onclose = disconnected;
}

// A bundled CLI also contains this module; URL equality alone would mistake
// its bundle for the standalone MCP server entry point.
if (/^server\.(?:js|ts)$/.test(basename(fileURLToPath(import.meta.url)))
    && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer({ rootDir: process.cwd() }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
