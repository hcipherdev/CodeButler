import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectRoot } from "../src/project-root.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("project root resolution", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  it("finds the nearest parent git repository", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".git"), { recursive: true });
    const nested = join(rootDir, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot({ cwd: nested, env: {} })).toMatchObject({
      rootDir,
      source: "git",
      foundGit: true
    });
  });

  it("prefers an explicit project root", () => {
    const cwd = makeTempDir();
    const explicitRoot = makeTempDir();
    tempDirs.push(cwd, explicitRoot);

    expect(resolveProjectRoot({ cwd, projectRoot: explicitRoot, env: {} })).toMatchObject({
      rootDir: explicitRoot,
      source: "argument"
    });
  });

  it("prefers CODE_BUTLER_PROJECT_ROOT when no explicit root is passed", () => {
    const cwd = makeTempDir();
    const envRoot = makeTempDir();
    tempDirs.push(cwd, envRoot);

    expect(resolveProjectRoot({ cwd, env: { CODE_BUTLER_PROJECT_ROOT: envRoot } })).toMatchObject({
      rootDir: envRoot,
      source: "environment"
    });
  });

  it("fails outside a git repository without initHere", () => {
    const cwd = makeTempDir();
    tempDirs.push(cwd);

    expect(() => resolveProjectRoot({ cwd, env: {} })).toThrow("No Git repository found");
  });

  it("uses cwd outside a git repository when initHere is enabled", () => {
    const cwd = makeTempDir();
    tempDirs.push(cwd);

    expect(resolveProjectRoot({ cwd, initHere: true, env: {} })).toMatchObject({
      rootDir: cwd,
      source: "cwd",
      foundGit: false
    });
  });
});
