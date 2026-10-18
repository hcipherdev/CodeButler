// Tests portable marker creation, Git continuity, remote normalization and lookup failures (lookupProjectRemote, assertBindingIdentity), and preservation of authored memory.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProjectIdentity, readProjectIdentity, identityCommitStatus, normalizeRemote, assertBindingIdentity, lookupProjectRemote, projectRemote, ProjectLinkChangedError, PROJECT_IDENTITY_FILE } from "../../src/cloud/project-identity.js";
import { OperationDeferredError } from "../../src/cloud/outcome.js";
import { hasProjectMemory } from "../../src/cloud/project-connections.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { gitExecutable } from "../../src/git-executable.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";

const roots: string[] = [];
const temp = () => { const root = makeTempDir(); roots.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
function git(root: string, ...args: string[]) {
  const result = spawnSync(gitExecutable(), ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("portable project identity", () => {
  it("writes only a version and UUID and preserves the file across moves and copies", () => {
    const parent = temp(), root = join(parent, "folder with spaces — 项目"); mkdirSync(root);
    const identity = ensureProjectIdentity(root), original = readFileSync(join(root, PROJECT_IDENTITY_FILE), "utf8");
    expect(Object.keys(JSON.parse(original)).sort()).toEqual(["projectIdentity", "version"]);
    expect(ensureProjectIdentity(root)).toEqual(identity);
    const moved = join(parent, "moved"), clone = join(parent, "clone"); renameSync(root, moved); mkdirSync(clone);
    copyFileSync(join(moved, PROJECT_IDENTITY_FILE), join(clone, PROJECT_IDENTITY_FILE));
    expect(readProjectIdentity(moved)).toEqual(identity); expect(ensureProjectIdentity(clone)).toEqual(identity);
    expect(readFileSync(join(clone, PROJECT_IDENTITY_FILE), "utf8")).toBe(original);
  });

  it.each(["{", JSON.stringify({ version: 2, projectIdentity: randomUUID() }), JSON.stringify({ version: 1, projectIdentity: "invalid" }), JSON.stringify({ version: 1, projectIdentity: randomUUID(), account: "private" })])("rejects malformed markers without replacing them", content => {
    const root = temp(), path = join(root, PROJECT_IDENTITY_FILE); writeFileSync(path, content);
    expect(() => ensureProjectIdentity(root)).toThrow("invalid"); expect(readFileSync(path, "utf8")).toBe(content);
    expect(() => ensureProjectIdentity(root, undefined, true)).toThrow("invalid");
  });

  it("rejects directories and conflicting identities; separation is explicit", () => {
    const root = temp(), identity = ensureProjectIdentity(root), original = readFileSync(join(root, PROJECT_IDENTITY_FILE), "utf8");
    expect(() => ensureProjectIdentity(root, randomUUID())).toThrow("differs"); expect(readFileSync(join(root, PROJECT_IDENTITY_FILE), "utf8")).toBe(original);
    const state = { projectIdentity: identity.projectIdentity, projectId: randomUUID(), vaultId: randomUUID(), server: "https://example.test", enabled: true, status: "ready", revision: 0, fingerprint: "" };
    ensureProjectIdentity(root, undefined, true); expect(() => assertBindingIdentity(root, state)).toThrow("changed");
    const directory = temp(); mkdirSync(join(directory, PROJECT_IDENTITY_FILE)); expect(() => readProjectIdentity(directory)).toThrow("invalid");
  });

  it("does not stage the marker and carries it through commits, branches, clones, and worktrees", () => {
    const root = temp(); git(root, "init", "-b", "main"); const identity = ensureProjectIdentity(root);
    expect(identityCommitStatus(root)).toBe("uncommitted"); expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    git(root, "add", PROJECT_IDENTITY_FILE); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Portable identity fixture");
    expect(identityCommitStatus(root)).toBe("committed"); git(root, "switch", "-c", "feature"); expect(ensureProjectIdentity(root)).toEqual(identity);
    const parent = temp(), clone = join(parent, "clone"), worktree = join(parent, "worktree");
    git(parent, "clone", root, clone); git(root, "worktree", "add", "-b", "worktree-test", worktree);
    expect(identityCommitStatus(clone)).toBe("committed"); expect(readProjectIdentity(worktree)).toEqual(identity);
    ensureProjectIdentity(worktree, undefined, true); expect(identityCommitStatus(worktree)).toBe("uncommitted"); expect(readProjectIdentity(root)).toEqual(identity);
    expect(existsSync(join(root, PROJECT_IDENTITY_FILE))).toBe(true);
  });

  it.each([
    "https://github.com/Owner/Repo.git", "https://username:password@github.com/owner/repo.git?token=private#branch",
    "git@github.com:owner/repo.git", "ssh://git@github.com:22/owner/repo.git", "git://github.com/owner/repo/"
  ])("normalizes equivalent origin hints without credentials: %s", remote => {
    expect(normalizeRemote(remote)).toBe("github.com/owner/repo");
  });

  it("keeps nondefault ports and refuses local or unsafe remote hints", () => {
    expect(normalizeRemote("ssh://git@git.example.test:2222/Team/Repo.git")).toBe("git.example.test:2222/Team/Repo");
    expect(normalizeRemote("C:\\Users\\owner\\repo")).toBeUndefined(); expect(normalizeRemote("file:///Users/owner/repo")).toBeUndefined();
    expect(normalizeRemote("https://github.com/")).toBeUndefined(); expect(normalizeRemote("/home/owner/repo")).toBeUndefined();
  });

  describe("remote checks for a bound folder", () => {
    const bound = (remoteHints: string[]) => {
      const root = temp(); git(root, "init", "-b", "main");
      const { projectIdentity } = ensureProjectIdentity(root);
      return { root, state: { projectIdentity, remoteHints, projectId: randomUUID(), vaultId: randomUUID(), server: "https://example.test", enabled: true, status: "ready", revision: 0, fingerprint: "" } };
    };

    it("pauses only for a verified origin change", () => {
      const { root, state } = bound(["github.com/owner/repo"]);
      git(root, "remote", "add", "origin", "git@github.com:Owner/Repo.git"); expect(() => assertBindingIdentity(root, state)).not.toThrow();
      git(root, "remote", "set-url", "origin", "git@github.com:owner/other.git"); expect(() => assertBindingIdentity(root, state)).toThrow(ProjectLinkChangedError);
      git(root, "remote", "remove", "origin"); expect(lookupProjectRemote(root)).toEqual({ state: "none" });
      expect(() => assertBindingIdentity(root, state)).toThrow(ProjectLinkChangedError);
      expect(() => assertBindingIdentity(root, { ...state, remoteHints: ["no-origin"] })).not.toThrow();
      expect(lookupProjectRemote(temp())).toEqual({ state: "none" });
    });

    it.skipIf(process.platform === "win32").each([
      ["cannot start", (dir: string) => join(dir, "missing-git")],
      ["is killed mid-call", (dir: string) => { const path = join(dir, "killed-git"); writeFileSync(path, "#!/bin/sh\nkill -9 $$\n", { mode: 0o755 }); return path; }]
    ])("defers instead of pausing when Git %s", (_label, executable) => {
      const { root, state } = bound(["github.com/owner/repo"]);
      git(root, "remote", "add", "origin", "git@github.com:owner/repo.git");
      vi.stubEnv("CODE_BUTLER_GIT", executable(temp()));
      expect(lookupProjectRemote(root)).toEqual({ state: "unavailable" }); expect(projectRemote(root)).toBeUndefined();
      let thrown: unknown; try { assertBindingIdentity(root, state); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OperationDeferredError); expect(thrown).not.toBeInstanceOf(ProjectLinkChangedError);
      expect((thrown as Error).message).not.toMatch(/identity|Git remote changed/);
    });
  });

  it("counts manually authored memories and candidates even with zero sources", () => {
    vi.stubEnv("CODE_BUTLER_HOME", temp()); const root = temp();
    const store = openConfiguredMemoryStore(root); store.init(); store.close(); expect(hasProjectMemory(root)).toBe(false);
    const authored = openConfiguredMemoryStore(root);
    try {
      const candidate = authored.upsertMemoryCandidate({ type: "decision", title: "Authored candidate", summary: "Keep manual memory when reconnecting.", reason: "Manual fixture", confidence: 1, evidence: [], relatedFiles: [], dedupeKey: "authored-with-no-sources" });
      expect(authored.db.prepare("select count(*) n from sources").get()!.n).toBe(0);
      expect(hasProjectMemory(root)).toBe(true);
      authored.promoteMemoryCandidate(candidate.id);
    } finally { authored.close(); }
    expect(hasProjectMemory(root)).toBe(true);
    const importsOnly = temp(); mkdirSync(join(importsOnly, ".code-butler", "imports"), { recursive: true }); writeFileSync(join(importsOnly, ".code-butler", "imports", "manual.md"), "Authored material");
    expect(hasProjectMemory(importsOnly)).toBe(true);
  });

  it("preserves manually authored handbooks and history while ignoring initialization coverage", () => {
    vi.stubEnv("CODE_BUTLER_HOME", temp()); const root = temp(), store = openConfiguredMemoryStore(root);
    try {
      store.init(); expect(hasProjectMemory(root)).toBe(false);
      store.db.prepare("insert into memory_topics(id,topic_id,layer,name,prefixes_json,parents_json,created_at) values(?,?,?,?,?,?,?)")
        .run("manual-topic", "manual-topic", "core", "Manual handbook", "[]", "[]", new Date().toISOString());
      expect(hasProjectMemory(root)).toBe(true);
      store.db.exec("delete from memory_topics; update memory_events set reason='Authored coverage note'");
      expect(hasProjectMemory(root)).toBe(true);
    } finally { store.close(); }
  });
});
