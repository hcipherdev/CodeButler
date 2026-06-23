import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ProjectRootSource = "argument" | "environment" | "git" | "cwd";

export interface ProjectRootResolution {
  rootDir: string;
  source: ProjectRootSource;
  foundGit: boolean;
}

export interface ResolveProjectRootOptions {
  cwd?: string;
  projectRoot?: string | undefined;
  initHere?: boolean;
  env?: Partial<Pick<NodeJS.ProcessEnv, "CODE_BUTLER_PROJECT_ROOT">> | undefined;
}

export function resolveProjectRoot(options: ResolveProjectRootOptions = {}): ProjectRootResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicitRoot = normalizeOptionalPath(cwd, options.projectRoot);
  if (explicitRoot) {
    assertDirectory(explicitRoot, "--project-root");
    return {
      rootDir: explicitRoot,
      source: "argument",
      foundGit: hasGitMarker(explicitRoot)
    };
  }

  const envRoot = normalizeOptionalPath(cwd, options.env?.CODE_BUTLER_PROJECT_ROOT ?? process.env.CODE_BUTLER_PROJECT_ROOT);
  if (envRoot) {
    assertDirectory(envRoot, "CODE_BUTLER_PROJECT_ROOT");
    return {
      rootDir: envRoot,
      source: "environment",
      foundGit: hasGitMarker(envRoot)
    };
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return {
      rootDir: gitRoot,
      source: "git",
      foundGit: true
    };
  }

  if (options.initHere) {
    assertDirectory(cwd, "cwd");
    return {
      rootDir: cwd,
      source: "cwd",
      foundGit: false
    };
  }

  throw new Error(
    "No Git repository found for Code Butler MCP startup. Run from inside a Git repository, pass --project-root <path>, set CODE_BUTLER_PROJECT_ROOT, or pass --init-here to initialize the current directory."
  );
}

function findGitRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (hasGitMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function hasGitMarker(rootDir: string): boolean {
  return existsSync(resolve(rootDir, ".git"));
}

function normalizeOptionalPath(cwd: string, value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return resolve(cwd, value);
}

function assertDirectory(path: string, label: string): void {
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  throw new Error(`${label} is not a directory: ${path}`);
}
