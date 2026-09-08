import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import { verifyDatabaseFile } from "../privacy/backup.js";
import { installationDeviceId } from "../memory/origin.js";
import { assertNoDatabaseHandles } from "./gate.js";
import { atomicJson, atomicWrite, binding, saveBinding, syncDirectory, readJson, sha256, stateDirectory, UUID, type Binding } from "./state.js";

export const MAX_COMPRESSED = 256 * 1024 * 1024;
export const MAX_EXPANDED = 1024 * 1024 * 1024;
const LOCAL_TABLES = ["sync_sources", "sync_cursors"];
const manifestSchema = z.object({
  format: z.literal("code-butler-cloud"), version: z.literal(1), appVersion: z.literal("1.0.0"),
  schemaVersion: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION), projectId: UUID,
  parentRevision: z.number().int().nonnegative(), installationId: UUID, checkoutId: UUID.optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string(), data: z.string(), checksum: z.string().regex(/^[a-f0-9]{64}$/) })).max(20000)
});
export type Snapshot = z.infer<typeof manifestSchema>;
export function excluded(path: string): boolean {
  const parts = path.split("/");
  return parts.some(p => p === "logs" || p === "backups" || p === "staging" || p.startsWith(".cloud") || p === "cloud" || p === "device.json" || (p.startsWith(".env") && p !== ".env.example") || p.endsWith(".lock") || p.endsWith(".tmp") || p === ".DS_Store") || /^memory\.sqlite(?:-|\.)/.test(path);
}
export function validArchivePath(path: string, platform: string = process.platform): void {
  if (!path || path.includes("\\") || path.startsWith("/") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === "..") || /^[a-z]:/i.test(path)) throw new Error("Invalid snapshot path");
  if (platform === "win32" && path.split("/").some(p => /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Snapshot filename cannot be represented on Windows");
}
function filesIn(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (excluded(relative)) continue;
    validArchivePath(relative);
    const stat = lstatSync(join(dir, name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported project file: ${relative}`);
    if (stat.isDirectory()) result.push(...filesIn(join(dir, name), relative)); else result.push(relative);
  }
  return result;
}
type Config = Record<string, any>;
export function portableConfig(config: Config): Config {
  const result: Config = {};
  for (const key of ["promotion", "deterministic", "privacy", "retention", "sync"]) if (config[key] !== undefined) result[key] = config[key];
  if (config.retrieval) result.retrieval = config.retrieval;
  if (config.sources) {
    result.sources = {};
    for (const key of ["git", "codex", "claude"]) {
      if (!config.sources[key]) continue;
      result.sources[key] = { ...config.sources[key] };
      for (const local of ["repoPath", "roots", "hookInstall", "includeDefaultRoots"]) delete result.sources[key][local];
    }
  }
  return result;
}
function mergedConfig(remote: Config, local: Config): Config {
  const value = { ...local, ...portableConfig(remote) };
  value.sources = {};
  for (const key of ["git", "codex", "claude"]) value.sources[key] = { ...local.sources?.[key], ...remote.sources?.[key] };
  return value;
}
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
export function databaseFingerprint(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = (db.prepare("pragma table_list").all() as Array<{ name: string; type: string; schema: string }>).filter(t => t.schema === "main" && t.type === "table" && !t.name.startsWith("sqlite_") && ![...LOCAL_TABLES, "operation_log", "schema_migrations"].includes(t.name)).map(t => t.name).sort();
    const tables = names.map(name => {
      const rows = db.prepare(`select * from ${quote(name)}`).all().map(row => {
        if (name === "temporary_memories") row.project_id = "@project";
        return JSON.stringify(row, (_k, v) => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v);
      }).sort();
      return [name, rows];
    });
    return sha256(JSON.stringify(tables));
  } finally { db.close(); }
}
export async function captureSnapshot(root: string, projectId: string, parentRevision: number, checkoutId?: string): Promise<{ snapshot: Snapshot; bytes: Buffer }> {
  const dir = join(root, ".code-butler");
  const temporary = join(stateDirectory(root), `capture-${randomUUID()}.sqlite`);
  mkdirSync(stateDirectory(root), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
  try { await backup(source, temporary); } finally { source.close(); }
  try {
    verifyDatabaseFile(temporary);
    const db = new DatabaseSync(temporary);
    try { for (const name of LOCAL_TABLES) db.exec(`delete from ${quote(name)}`); } finally { db.close(); }
    const logicalHash = databaseFingerprint(temporary);
    const files: Snapshot["files"] = [];
    const hashes: Array<[string, string]> = [];
    let total = 0;
    for (const path of filesIn(dir)) {
      let bytes = path === "memory.sqlite" ? readFileSync(temporary) : readFileSync(join(dir, path));
      if (path === "config.json") bytes = Buffer.from(JSON.stringify(portableConfig(JSON.parse(bytes.toString()))));
      total += bytes.length;
      if (total > MAX_EXPANDED) throw new Error("Snapshot exceeds expanded limit");
      files.push({ path, data: bytes.toString("base64"), checksum: sha256(bytes) });
      hashes.push([path, path === "memory.sqlite" ? logicalHash : sha256(bytes)]);
    }
    const snapshot: Snapshot = { format: "code-butler-cloud", version: 1, appVersion: "1.0.0", schemaVersion: CURRENT_SCHEMA_VERSION, projectId, parentRevision, installationId: installationDeviceId(), ...(checkoutId ? { checkoutId: UUID.parse(checkoutId) } : {}), fingerprint: sha256(JSON.stringify(hashes)), files };
    const encoded = Buffer.from(JSON.stringify(snapshot));
    if (encoded.length > MAX_EXPANDED) throw new Error("Encoded snapshot exceeds expanded limit");
    const bytes = gzipSync(encoded);
    if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
    return { snapshot, bytes };
  } finally { rmSync(temporary, { force: true }); }
}
export function decodeSnapshot(bytes: Buffer, platform: string = process.platform): Snapshot {
  if (bytes.length > MAX_COMPRESSED) throw new Error("Snapshot exceeds compressed limit");
  const snapshot = manifestSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }).toString()));
  const seen = new Set<string>();
  const paths = new Set(snapshot.files.map(f => f.path));
  let total = 0;
  for (const file of snapshot.files) {
    validArchivePath(file.path, platform);
    const components = file.path.split("/");
    if (components.slice(0, -1).some((_p, i) => paths.has(components.slice(0, i + 1).join("/")))) throw new Error("Snapshot file/directory collision");
    if (excluded(file.path)) throw new Error("Snapshot contains excluded files");
    const key = platform === "linux" ? file.path : file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Snapshot contains colliding paths"); seen.add(key);
    const data = Buffer.from(file.data, "base64"); total += data.length;
    if (total > MAX_EXPANDED || data.toString("base64") !== file.data || sha256(data) !== file.checksum) throw new Error("Invalid snapshot checksum or size");
  }
  if (!seen.has("memory.sqlite")) throw new Error("Snapshot database missing");
  const config = snapshot.files.find(f => f.path === "config.json");
  if (config && JSON.stringify(portableConfig(JSON.parse(Buffer.from(config.data, "base64").toString()))) !== Buffer.from(config.data, "base64").toString()) throw new Error("Snapshot contains nonportable configuration");
  return snapshot;
}
interface Journal { previousBinding?: Binding; files: Array<{ path: string; data: string }>; incoming: string[] }
export function recoverApply(root: string): void {
  const path = join(stateDirectory(root), "apply-journal.json");
  const journal = readJson<Journal>(path); if (!journal) return;
  assertNoDatabaseHandles(root);
  const dir = join(root, ".code-butler");
  for (const name of journal.incoming) { validArchivePath(name); rmSync(join(dir, name), { force: true }); }
  for (const file of journal.files) { validArchivePath(file.path); mkdirSync(join(dir, file.path, ".."), { recursive: true }); atomicWrite(join(dir, file.path), Buffer.from(file.data, "base64")); }
  for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `memory.sqlite${suffix}`), { force: true });
  verifyDatabaseFile(join(dir, "memory.sqlite"));
  if (journal.previousBinding) saveBinding(root, journal.previousBinding);
  rmSync(path); syncDirectory(stateDirectory(root));
}
export function applySnapshot(root: string, snapshot: Snapshot): void {
  assertNoDatabaseHandles(root);
  const dir = join(root, ".code-butler"); const state = stateDirectory(root);
  mkdirSync(state, { recursive: true });
  const staged = join(state, `restore-${randomUUID()}.sqlite`);
  writeFileSync(staged, Buffer.from(snapshot.files.find(f => f.path === "memory.sqlite")!.data, "base64"));
  try {
    verifySnapshotDatabase(snapshot, staged);
    const target = new DatabaseSync(staged);
    const original = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      const checkpoint = original.prepare("pragma wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (checkpoint.busy) throw new Error("Cloud restore deferred: SQLite is busy");
      for (const name of LOCAL_TABLES) {
        target.exec(`delete from ${quote(name)}`);
        for (const row of original.prepare(`select * from ${quote(name)}`).all()) {
          const keys = Object.keys(row); target.prepare(`insert into ${quote(name)} (${keys.map(quote)}) values (${keys.map(() => "?")})`).run(...keys.map(k => row[k]!));
        }
      }
      target.prepare("update temporary_memories set project_id = ?").run(root);
      target.prepare("update temporary_memories_fts set project_id = ?").run(root);
    } finally { original.close(); target.close(); }
    const existing = filesIn(dir);
    const previousBinding = binding(root);
    const journal: Journal = { ...(previousBinding ? { previousBinding } : {}), files: existing.map(path => ({ path, data: readFileSync(join(dir, path)).toString("base64") })), incoming: snapshot.files.map(f => f.path) };
    atomicJson(join(state, "recovery.json"), journal);
    atomicJson(join(state, "apply-journal.json"), journal);
    const local = readJson<Config>(join(dir, "config.json")) ?? {};
    try {
      for (const path of existing) rmSync(join(dir, path), { force: true });
      for (const file of snapshot.files) {
        mkdirSync(join(dir, file.path, ".."), { recursive: true });
        const data = file.path === "memory.sqlite" ? readFileSync(staged) : file.path === "config.json" ? Buffer.from(JSON.stringify(mergedConfig(JSON.parse(Buffer.from(file.data, "base64").toString()), local))) : Buffer.from(file.data, "base64");
        atomicWrite(join(dir, file.path), data);
      }
      // A snapshot without config still preserves local configuration.
      if (!snapshot.files.some(f => f.path === "config.json")) atomicJson(join(dir, "config.json"), local);
      for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `memory.sqlite${suffix}`), { force: true });
      verifyDatabaseFile(join(dir, "memory.sqlite")); rmSync(join(state, "apply-journal.json")); syncDirectory(state);
    } catch (error) { recoverApply(root); throw error; }
  } finally { rmSync(staged, { force: true }); }
}

export function verifySnapshotDatabase(snapshot: Snapshot, databasePath: string): void {
  verifyDatabaseFile(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("select max(version) as version from schema_migrations").get() as { version: number };
    if (row.version !== snapshot.schemaVersion) throw new Error("Snapshot schema version mismatch");
  } finally { db.close(); }
  const hashes = snapshot.files.map(file => [file.path, file.path === "memory.sqlite" ? databaseFingerprint(databasePath) : file.checksum]);
  if (sha256(JSON.stringify(hashes)) !== snapshot.fingerprint) throw new Error("Snapshot logical fingerprint mismatch");
}
