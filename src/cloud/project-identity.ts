import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { gitExecutable } from "../git-executable.js";
import { sha256, syncDirectory, type Binding } from "./state.js";
import { OperationDeferredError } from "./outcome.js";

export const PROJECT_IDENTITY_FILE = ".code-butler-project.json";
const schema = z.object({ version: z.literal(1), projectIdentity: z.string().uuid() }).strict();
export type ProjectIdentity = z.infer<typeof schema>;

export function readProjectIdentity(root: string): ProjectIdentity | undefined {
  const path = join(root, PROJECT_IDENTITY_FILE);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The project identity file is invalid. Restore its committed version before reconnecting.");
  }
}

/** Publish a complete file without overwriting a concurrently created identity. */
export function ensureProjectIdentity(root: string, requested?: string, replace = false): ProjectIdentity {
  const current = readProjectIdentity(root);
  if (current && !replace) {
    if (requested && current.projectIdentity !== requested) throw new Error("Project identity differs from the selected cloud project. Start a separate identity or choose the matching project.");
    return current;
  }
  const value = schema.parse({ version: 1, projectIdentity: requested ?? randomUUID() });
  const path = join(root, PROJECT_IDENTITY_FILE), temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (replace) renameSync(temporary, path);
    else {
      try { linkSync(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = readProjectIdentity(root)!;
        if (requested && winner.projectIdentity !== requested) throw new Error("The project identity changed during setup. Inspect the connection again.");
        return winner;
      }
    }
    syncDirectory(root);
    return value;
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync(gitExecutable(), ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function identityCommitStatus(root: string): "missing" | "uncommitted" | "committed" {
  const identity = readProjectIdentity(root);
  if (!identity) return "missing";
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  const committed = prefix !== undefined ? git(root, ["show", `HEAD:${prefix}${PROJECT_IDENTITY_FILE}`]) : undefined;
  const normalizeLines = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return committed && normalizeLines(committed) === normalizeLines(readFileSync(join(root, PROJECT_IDENTITY_FILE), "utf8")) ? "committed" : "uncommitted";
}

export function normalizeRemote(raw: string): string | undefined {
  try {
    const value = raw.trim();
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
    const url = new URL(scp && !value.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || !url.hostname) return undefined;
    let path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path || path.includes("..") || /[\s\\]/.test(path)) return undefined;
    if (["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname.toLowerCase())) path = path.toLowerCase();
    return `${url.hostname.toLowerCase()}${url.port && !["22", "80", "443"].includes(url.port) ? `:${url.port}` : ""}/${path}`;
  } catch { return undefined; }
}

export type RemoteLookup = { state: "found"; remote: string } | { state: "none" } | { state: "unavailable" };

/** Distinguishes "no origin" from a failed lookup so a slow or interrupted Git call is never read as a remote change. */
export function lookupProjectRemote(root: string): RemoteLookup {
  const result = spawnSync(gitExecutable(), ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true, timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
  if (result.status === 0) {
    const raw = result.stdout.trim();
    return raw ? { state: "found", remote: normalizeRemote(raw) ?? `opaque:${sha256(raw)}` } : { state: "none" };
  }
  // Exit 2 is "No such remote"; exit 128 outside a repository. Timeouts, signals, spawn and permission failures stay unknown.
  if (result.status === 2 || (result.status === 128 && /not a git repository/i.test(result.stderr ?? ""))) return { state: "none" };
  return { state: "unavailable" };
}

export function projectRemote(root: string): string | undefined {
  const lookup = lookupProjectRemote(root);
  return lookup.state === "found" ? lookup.remote : undefined;
}

/** A verified identity or remote mismatch; sync stays paused until the user reviews the link. */
export class ProjectLinkChangedError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectLinkChangedError"; }
}

export function assertBindingIdentity(root: string, state: Binding, allowRemoteChange = false): void {
  const marker = readProjectIdentity(root);
  if (state.projectIdentity && marker && marker.projectIdentity !== state.projectIdentity) throw new ProjectLinkChangedError("The project identity changed. Sync is paused until you review and relink this folder.");
  if (!state.projectIdentity || allowRemoteChange || !state.remoteHints?.length) return;
  const lookup = lookupProjectRemote(root);
  if (lookup.state === "unavailable") throw new OperationDeferredError("Could not read the Git origin URL; sync will retry.");
  if (!state.remoteHints.includes(lookup.state === "found" ? lookup.remote : "no-origin")) throw new ProjectLinkChangedError("The Git remote changed. Sync is paused until you choose whether to continue existing memory or start a separate identity.");
}
