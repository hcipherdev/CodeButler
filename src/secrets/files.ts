import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, closeSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { HASH } from "../cloud/encrypted-protocol.js";
import { atomicWrite, sha256, UUID } from "../cloud/state.js";
import { SecretFolderError } from "./folder-error.js";
import { restrictSecretDirectory } from "./permissions.js";

export const SECRET_BLOCK_SIZE = 64 * 1024;
export const MAX_SECRET_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SECRET_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_SECRET_FILES = 1000;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const fileSchema = z.object({ path: z.string().min(1).max(1024), hash: HASH, size: z.number().int().nonnegative().max(MAX_SECRET_FILE_BYTES), blocks: z.array(HASH).max(MAX_SECRET_FILE_BYTES / SECRET_BLOCK_SIZE) }).strict();
const manifestSchema = z.object({ format: z.literal("code-butler-secrets"), version: z.literal(1), projectId: UUID,
  parentRevision: z.number().int().nonnegative(), installationId: UUID, files: z.array(fileSchema).max(MAX_SECRET_FILES) }).strict();
export type SecretManifest = z.infer<typeof manifestSchema>;
export interface SecretBundle { manifest: SecretManifest; blocks: Map<string, Buffer> }

function fail(): never { throw new EncryptionError("verification-failed"); }
export function validateSecretPath(path: string): string {
  if (!path || path.includes("\\") || path.startsWith("/") || path.includes("\0") || path.normalize("NFC") !== path
    || Buffer.byteLength(path, "utf8") > 1024) return fail();
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")
      || Buffer.byteLength(part, "utf8") > 255 || part.length > 255
      || WINDOWS_RESERVED.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))) return fail();
  return path;
}
export function validateSecretManifest(value: unknown): SecretManifest {
  let manifest: SecretManifest;
  try { manifest = manifestSchema.parse(value); } catch { return fail(); }
  let last = "", total = 0;
  const folded = new Set<string>();
  for (const file of manifest.files) {
    validateSecretPath(file.path);
    const lower = file.path.toLocaleLowerCase("en-US");
    if (file.path <= last || folded.has(lower) || file.blocks.length !== Math.ceil(file.size / SECRET_BLOCK_SIZE)) fail();
    folded.add(lower); last = file.path; total += file.size;
    if (total > MAX_SECRET_TOTAL_BYTES) fail();
  }
  // A file cannot also be the parent directory of another file.
  for (const file of manifest.files) for (const part of parentPaths(file.path)) if (folded.has(part.toLocaleLowerCase("en-US"))) fail();
  if (collidingNames(manifest.files.map(file => file.path)).length) fail();
  return manifest;
}
function parentPaths(path: string): string[] {
  const parts = path.split("/"), result: string[] = [];
  for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join("/"));
  return result;
}
function collidingNames(names: Iterable<string>): string[] {
  const seen = new Map<string, { part: string; name: string }>(), conflicts = new Set<string>();
  for (const name of names) {
    for (const part of [...parentPaths(name), name]) {
      const key = part.toLocaleLowerCase("en-US"), earlier = seen.get(key);
      if (earlier && earlier.part !== part) { conflicts.add(name); conflicts.add(earlier.name); }
      else seen.set(key, { part, name });
    }
  }
  return [...conflicts].sort();
}
function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(".." + sep) || resolve(path) === resolve(root) || rel.startsWith(sep)) fail();
}
/**
 * Reads one file under `root`, the secrets folder as the project names it. The path is checked against that,
 * the resolved path against the resolved folder: a project reached through a symlink (macOS /var, a linked
 * Documents folder) is fine, a link inside the folder pointing out of it is not.
 */
function readRegularFile(root: string, path: string): Buffer {
  assertInside(root, path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_SECRET_FILE_BYTES) fail();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0));
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.size !== before.size) fail();
    assertInside(realpathSync(root), realpathSync(path));
    const bytes = Buffer.allocUnsafe(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) fail();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) fail();
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) fail();
    return bytes;
  } finally { closeSync(fd); }
}
const MiB = 1024 * 1024;
/** Keep only keys, certificates and credential files in secrets/; tools, data and logs belong elsewhere. */
const KEEP_SMALL = "Keep only keys, certificates and credential files there; move tools, test data and logs out of secrets/.";
export function captureSecretFolder(root: string, projectId: string, parentRevision: number, installationId: string): SecretBundle {
  const directory = join(root, "secrets");
  const blocks = new Map<string, Buffer>();
  const files: SecretManifest["files"] = [];
  let totalBytes = 0;
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw new SecretFolderError("secrets is not a regular folder (it is a link or a file). Secrets sync needs a real secrets/ folder.");
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name), stat = lstatSync(path);
        const name = relative(directory, path).split(sep).join("/");
        if (stat.isSymbolicLink()) throw new SecretFolderError(`secrets/${name} is a link. Secrets sync copies regular files only; replace it with the file itself.`);
        if (stat.isDirectory()) { walk(path); continue; }
        if (!stat.isFile() || stat.nlink !== 1) throw new SecretFolderError(`secrets/${name} is not a regular file (a device, pipe or hard link). Secrets sync copies regular files only.`);
        try { validateSecretPath(name); }
        catch { throw new SecretFolderError(`secrets/${name} has a name some systems cannot store (CON, NUL and similar, a trailing dot or space, or one of < > : " | ? *). Rename it.`); }
        if (stat.size > MAX_SECRET_FILE_BYTES) throw new SecretFolderError(`secrets/${name} is ${(stat.size / MiB).toFixed(1)} MB; one file can be at most ${MAX_SECRET_FILE_BYTES / MiB} MB. ${KEEP_SMALL}`);
        totalBytes += stat.size;
        if (totalBytes > MAX_SECRET_TOTAL_BYTES) throw new SecretFolderError(`secrets/ holds more than ${MAX_SECRET_TOTAL_BYTES / MiB} MB, the limit. ${KEEP_SMALL}`);
        if (files.length + 1 > MAX_SECRET_FILES) throw new SecretFolderError(`secrets/ holds more than ${MAX_SECRET_FILES.toLocaleString("en-US")} files, the limit. ${KEEP_SMALL}`);
        const bytes = readRegularFile(directory, path);
        const hashes: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += SECRET_BLOCK_SIZE) {
          const chunk = bytes.subarray(offset, offset + SECRET_BLOCK_SIZE), hash = sha256(chunk);
          hashes.push(hash); blocks.set(hash, chunk);
        }
        files.push({ path: name, hash: sha256(bytes), size: bytes.length, blocks: hashes });
      }
    };
    walk(directory);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const colliding = collidingNames(files.map(file => file.path));
  if (colliding.length) throw new SecretFolderError(`secrets/${colliding[0]} and secrets/${colliding[1]} differ only in letter case, which Windows and macOS cannot keep apart. Rename one.`);
  const manifest = validateSecretManifest({ format: "code-butler-secrets", version: 1, projectId, parentRevision, installationId, files });
  return { manifest, blocks };
}
export function materializeSecretFiles(bundle: SecretBundle): Map<string, Buffer> {
  const manifest = validateSecretManifest(bundle.manifest), files = new Map<string, Buffer>();
  const used = new Set<string>();
  for (const file of manifest.files) {
    const pieces = file.blocks.map((hash, i) => {
      const bytes = bundle.blocks.get(hash);
      if (!bytes || bytes.length !== (i === file.blocks.length - 1 ? file.size - i * SECRET_BLOCK_SIZE : SECRET_BLOCK_SIZE) || sha256(bytes) !== hash) return fail();
      used.add(hash); return bytes;
    });
    const content = Buffer.concat(pieces);
    if (sha256(content) !== file.hash) fail();
    files.set(file.path, content);
  }
  if (used.size !== bundle.blocks.size) fail();
  return files;
}
export interface SecretMerge { files: Map<string, Buffer>; conflicts: string[] }
export function mergeSecretFiles(base: SecretBundle | undefined, local: SecretBundle, remote: SecretBundle | undefined,
  resolutions: Record<string, "local" | "remote"> = {}): SecretMerge {
  const left = materializeSecretFiles(local), right = remote ? materializeSecretFiles(remote) : new Map<string, Buffer>();
  const ancestor = base ? materializeSecretFiles(base) : new Map<string, Buffer>();
  const bootstrap = !base && Boolean(remote);
  const result = new Map<string, Buffer>(), conflicts: string[] = [];
  const names = new Set([...left.keys(), ...right.keys(), ...ancestor.keys()]);
  const same = (a?: Buffer, b?: Buffer) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
  for (const name of [...names].sort()) {
    const l = left.get(name), r = right.get(name), b = ancestor.get(name);
    const choice = resolutions[name];
    const chosen = choice === "local" ? l : choice === "remote" ? r
      : bootstrap && l === undefined ? r
      : same(l, r) ? l
      : same(l, b) ? r
      : same(r, b) ? l
      : undefined;
    if (chosen === undefined && !choice && !(same(l, b) && r === undefined) && !(same(r, b) && l === undefined) && !(l === undefined && r === undefined)) {
      conflicts.push(name); continue;
    }
    if (chosen !== undefined) result.set(name, chosen);
  }
  for (const name of result.keys()) for (const parent of parentPaths(name)) if (result.has(parent)) conflicts.push(name);
  conflicts.push(...collidingNames(result.keys()));
  return { files: result, conflicts: [...new Set(conflicts)].sort() };
}
/** Applies only after every ciphertext block and path has been validated. */
export function applySecretFiles(root: string, expected: SecretBundle, desired: Map<string, Buffer>): void {
  const directory = join(root, "secrets");
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) fail();
  const expectedFiles = materializeSecretFiles(expected);
  for (const name of new Set([...expectedFiles.keys(), ...desired.keys()])) validateSecretPath(name);
  if (collidingNames(desired.keys()).length) fail();
  // Check all preimages before the first mutation, so an edit made by another process becomes a conflict.
  const actual = captureSecretFolder(root, expected.manifest.projectId, expected.manifest.parentRevision, expected.manifest.installationId);
  const current = materializeSecretFiles(actual);
  if (current.size !== expectedFiles.size || [...current].some(([name, bytes]) => !expectedFiles.get(name)?.equals(bytes))) throw new EncryptionError("conflict");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  restrictSecretDirectory(directory);
  for (const name of expectedFiles.keys()) if (!desired.has(name)) {
    const target = join(directory, ...name.split("/"));
    if (!readRegularFile(directory, target).equals(expectedFiles.get(name)!)) throw new EncryptionError("conflict");
    unlinkSync(target);
    let parent = dirname(target);
    while (parent !== directory) {
      try { rmdirSync(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; break; }
      parent = dirname(parent);
    }
  }
  for (const [name, bytes] of desired) {
    if (expectedFiles.get(name)?.equals(bytes)) continue;
    const target = join(directory, ...name.split("/"));
    let parent = dirname(target);
    const parents: string[] = [];
    while (parent !== directory) { parents.push(parent); parent = dirname(parent); }
    for (const item of parents.reverse()) {
      if (existsSync(item) && (!lstatSync(item).isDirectory() || lstatSync(item).isSymbolicLink())) fail();
      if (!existsSync(item)) mkdirSync(item, { recursive: false, mode: 0o700 });
      restrictSecretDirectory(item);
    }
    const expectedBytes = expectedFiles.get(name);
    if (expectedBytes) {
      if (!readRegularFile(directory, target).equals(expectedBytes)) throw new EncryptionError("conflict");
    } else if (existsSync(target)) throw new EncryptionError("conflict");
    atomicWrite(target, bytes);
  }
}
