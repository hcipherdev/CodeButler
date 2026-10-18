// Ensures historical secrets/ changes never enter Git memory ingestion, including mixed commits.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { gitExecutable } from "../../src/git-executable.js";
import { scanGitSource } from "../../src/sources/git.js";
import { ensureSecretsGitGuard } from "../../src/secrets/state.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("skips secret-only and mixed commits before reading their messages or diffs", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-secret-git-")); roots.push(root);
  const git = (...args: string[]) => execFileSync(gitExecutable(), args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "README.md"), "Safe note\n"); git("add", "README.md"); git("commit", "-m", "safe commit");
  mkdirSync(join(root, "secrets")); writeFileSync(join(root, "secrets", ".env"), "TEST_SECRET_DO_NOT_USE_11c5938c\n");
  git("add", "secrets/.env"); git("commit", "-m", "secret commit TEST_SECRET_DO_NOT_USE_11c5938c");
  writeFileSync(join(root, "README.md"), "Safe note updated\n"); writeFileSync(join(root, "secrets", ".env"), "TEST_SECRET_DO_NOT_USE_65e18a71\n");
  git("add", "README.md", "secrets/.env"); git("commit", "-m", "mixed secret commit");
  const scan = scanGitSource({ enabled: true, repoPath: root, hookInstall: false, maxCommits: 10, maxDiffChars: 10000 });
  expect(scan.commits).toHaveLength(1);
  expect(scan.commits[0]?.changedFiles).toEqual(["README.md"]);
  expect(JSON.stringify(scan.commits)).not.toContain("TEST_SECRET_DO_NOT_USE");
});
it("blocks tracked secrets and adds a root ignore rule after they leave the index", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-secret-guard-")); roots.push(root);
  const git = (...args: string[]) => execFileSync(gitExecutable(), args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init");
  mkdirSync(join(root, "secrets")); writeFileSync(join(root, "secrets", ".env"), "guard fixture");
  git("add", "secrets/.env");
  expect(() => ensureSecretsGitGuard(root)).toThrow(/tracked by Git/);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  git("rm", "--cached", "secrets/.env");
  ensureSecretsGitGuard(root);
  ensureSecretsGitGuard(root);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/secrets/\n");
});
