import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectOperation } from "../cloud/client.js";
import { OperationDeferredError } from "../cloud/outcome.js";
import { ensureProjectConfig, loadGeneralSettings } from "../config.js";
import { findGitRoot } from "../project-root.js";
import { validateProjectSetupPaths } from "../project-setup.js";
import { assertOrdinaryProject } from "../rules/identity.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import type { ProjectStartupMetadata } from "./tools.js";

/** How an MCP connection chose its project: at launch, from the client's roots, or from the agent's working directory. */
export type ProjectBindingSource = "launch" | "roots" | "agent";

export const NO_PROJECT_HINT = "Call current_project with projectRoot set to your current working directory (an absolute path inside a Git repository).";

/** Thrown by every project tool while a connection has no project; the MCP SDK returns the message as a tool error. */
export class NoProjectError extends Error {
  readonly code = "no_project";
  constructor() { super(`no_project: Code Butler has no project yet. ${NO_PROJECT_HINT}`); }
}

export interface UnboundProjectInfo { bound: false; reason: string; hint: string; rootDir?: string }

export const PROJECT_INITIALIZATION_HINT = "Add this folder in the Code Butler desktop app, run code-butler init there, or enable Settings > General > Automatically initialize new projects on this computer.";

export class ProjectInitializationDisabledError extends Error {
  constructor(readonly rootDir: string) {
    super(`Project memory is not initialized at ${rootDir}, and automatic project initialization is disabled. ${PROJECT_INITIALIZATION_HINT}`);
  }
}

export function automaticProjectInitializationEnabled(override?: boolean): boolean {
  return override ?? loadGeneralSettings().autoInitializeProjects;
}

/** Check before any locks or config/store opens, which themselves create project files. */
export function assertMcpProjectAvailable(rootDir: string, autoInit?: boolean): void {
  if (existsSync(join(rootDir, ".code-butler", "config.json")) && existsSync(join(rootDir, ".code-butler", "memory.sqlite"))) return;
  if (!automaticProjectInitializationEnabled(autoInit)) throw new ProjectInitializationDisabledError(rootDir);
}

/**
 * Create the project's store and config before serving it, reporting what this start created.
 * It runs before the client's handshake, so it never waits on the project lock for an existing
 * project: another server's startup or the watcher may hold it, and every tool call opens and
 * migrates the store under the lock anyway.
 */
export async function prepareMcpProject(rootDir: string, autoInit?: boolean): Promise<ProjectStartupMetadata> {
  assertMcpProjectAvailable(rootDir, autoInit);
  const configCreated = !existsSync(join(rootDir, ".code-butler", "config.json"));
  const databaseCreated = !existsSync(join(rootDir, ".code-butler", "memory.sqlite"));
  validateProjectSetupPaths(rootDir, false);
  if (!configCreated && !databaseCreated) return { configCreated, databaseCreated };
  try {
    await projectOperation(rootDir, () => {
      validateProjectSetupPaths(rootDir, false);
      const store = openConfiguredMemoryStore(rootDir);
      try { store.init(); } finally { store.close(); }
      ensureProjectConfig(rootDir);
    });
  } catch (error) {
    if (!(error instanceof OperationDeferredError)) throw error;
    // Someone else holds the lock, so this project is being set up already; serve it and let tools wait.
    console.error("Code Butler is busy with another operation on this project; starting anyway");
  }
  return { configCreated, databaseCreated };
}

/** The Git repository containing a client root URI or an absolute path, if there is one. */
export function gitRootFor(pathOrUri: string): string | undefined {
  let path = pathOrUri.trim();
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path); } catch { return undefined; }
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(path) || !isAbsolute(path)) return undefined;
  if (!existsSync(path)) return undefined;
  const root = findGitRoot(resolve(path));
  if (!root) return undefined;
  try { assertOrdinaryProject(root); } catch { return undefined; }
  return root;
}

/** Resolve an agent-supplied working directory, explaining why it cannot be used. */
export function agentProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot.trim()) && !/^file:/i.test(projectRoot.trim())) throw new Error(`projectRoot must be an absolute path: ${projectRoot}`);
  const root = gitRootFor(projectRoot);
  if (!root) throw new Error(`No Git repository contains ${projectRoot}. Open the client inside a Git repository, or run code-butler init there.`);
  return root;
}
