import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { decodeSnapshot, MAX_COMPRESSED, verifySnapshotDatabase } from "./snapshot.js";
import { atomicWrite, sha256, UUID } from "./state.js";

const DAY = 86400000;
interface Vault { id: string; expires_at: number; revoked: number }
export class CloudError extends Error { constructor(public status: number, message: string) { super(message); } }
export class CloudService {
  readonly db: DatabaseSync;
  constructor(readonly directory: string, readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "blobs"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "cloud.sqlite"));
    this.db.exec(`pragma journal_mode=WAL; pragma busy_timeout=5000; pragma foreign_keys=ON;
      create table if not exists vaults(id text primary key, secret_hash text unique not null, issued_at integer not null, expires_at integer not null, revoked integer not null default 0);
      create table if not exists projects(id text primary key, vault_id text not null references vaults(id), name text not null, head integer not null default 0);
      create table if not exists revisions(project_id text not null references projects(id) on delete cascade, revision integer not null, fingerprint text not null, checksum text not null, blob text not null, created_at integer not null, checkout_id text, installation_id text, primary key(project_id,revision));
      create table if not exists uploads(project_id text not null references projects(id) on delete cascade, upload_id text not null, checksum text not null, revision integer not null, primary key(project_id,upload_id));`);
    this.ensureRevisionIdentityColumns();
  }
  private ensureRevisionIdentityColumns(): void {
    const columns = new Set((this.db.prepare("pragma table_info(revisions)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("checkout_id")) this.db.exec("alter table revisions add column checkout_id text");
    if (!columns.has("installation_id")) this.db.exec("alter table revisions add column installation_id text");
  }
  close(): void { this.db.close(); }
  issue(): { vaultId: string; secret: string; expiresAt: number } {
    const secret = randomBytes(32).toString("base64url"); const vaultId = randomUUID(); const expiresAt = this.now() + 185 * DAY;
    this.db.prepare("insert into vaults(id,secret_hash,issued_at,expires_at) values(?,?,?,?)").run(vaultId, sha256(secret), this.now(), expiresAt);
    return { vaultId, secret, expiresAt };
  }
  list(): unknown[] { return this.db.prepare("select id,issued_at,expires_at,revoked from vaults order by issued_at desc").all(); }
  extend(id: string, days = 185): void {
    UUID.parse(id); if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Invalid extension days");
    const row = this.db.prepare("select expires_at from vaults where id=?").get(id) as { expires_at: number } | undefined;
    if (!row) throw new Error("Unknown vault");
    this.db.prepare("update vaults set expires_at=?,revoked=0 where id=?").run(Math.max(this.now(), row.expires_at) + days * DAY, id);
  }
  revoke(id: string): void { UUID.parse(id); this.db.prepare("update vaults set revoked=1 where id=?").run(id); }
  authenticate(secret: string): Vault {
    const vault = this.db.prepare("select id,expires_at,revoked from vaults where secret_hash=?").get(sha256(secret)) as Vault | undefined;
    if (!vault || vault.revoked) throw new CloudError(401, "Invalid or revoked beta code");
    if (vault.expires_at <= this.now()) throw new CloudError(403, "Beta access expired; local memory remains available");
    return vault;
  }
  project(vault: Vault, id: string): { id: string; name: string; head: number } {
    UUID.parse(id);
    const row = this.db.prepare("select id,name,head from projects where id=? and vault_id=?").get(id, vault.id) as { id: string; name: string; head: number } | undefined;
    if (!row) throw new CloudError(404, "Project not found"); return row;
  }
  head(vault: Vault, id: string): unknown {
    const project = this.project(vault, id);
    const rev = this.db.prepare("select revision,fingerprint,checksum,checkout_id as checkoutId,installation_id as installationId from revisions where project_id=? and revision=?").get(id, project.head);
    return rev ?? { revision: 0, fingerprint: "", checksum: "" };
  }
  removeProject(id: string): void {
    const blobs = this.db.prepare("select blob from revisions where project_id=?").all(id) as Array<{ blob: string }>;
    this.db.prepare("delete from projects where id=?").run(id);
    for (const b of blobs) rmSync(join(this.directory, "blobs", b.blob), { force: true });
  }
  maintenance(): void {
    const expired = this.db.prepare("select id from vaults where expires_at <= ?").all(this.now() - 30 * DAY) as Array<{ id: string }>;
    for (const vault of expired) {
      for (const p of this.db.prepare("select id from projects where vault_id=?").all(vault.id) as Array<{ id: string }>) this.removeProject(p.id);
    }
    const keep = new Set((this.db.prepare("select blob from revisions").all() as Array<{ blob: string }>).map(r => r.blob));
    for (const name of readdirSync(join(this.directory, "blobs"))) if (!keep.has(name) && this.now() - statSync(join(this.directory, "blobs", name)).mtimeMs > DAY) rmSync(join(this.directory, "blobs", name), { force: true });
  }
  publish(vault: Vault, id: string, uploadId: string, bytes: Buffer, checksum: string): unknown {
    this.project(vault, id); UUID.parse(uploadId);
    if (sha256(bytes) !== checksum) throw new CloudError(400, "Upload checksum mismatch");
    const snapshot = decodeSnapshot(bytes, "linux");
    if (snapshot.projectId !== id) throw new CloudError(400, "Snapshot project mismatch");
    const checkPath = join(this.directory, `verify-${randomUUID()}.sqlite`);
    try { writeFileSync(checkPath, Buffer.from(snapshot.files.find(f => f.path === "memory.sqlite")!.data, "base64"), { mode: 0o600 }); verifySnapshotDatabase(snapshot, checkPath); }
    finally { rmSync(checkPath, { force: true }); }
    const currentAccess = this.db.prepare("select expires_at,revoked from vaults where id=?").get(vault.id) as Vault | undefined;
    if (!currentAccess || currentAccess.revoked || currentAccess.expires_at <= this.now()) throw new CloudError(403, "Beta access unavailable");
    this.db.exec("begin immediate");
    let blob: string | undefined;
    try {
      const previous = this.db.prepare("select revision,checksum from uploads where project_id=? and upload_id=?").get(id, uploadId) as { revision: number; checksum: string } | undefined;
      if (previous) {
        if (previous.checksum !== checksum) throw new CloudError(409, "Upload identifier already used for different content");
        this.db.exec("commit"); return { revision: previous.revision, fingerprint: snapshot.fingerprint, checksum };
      }
      const head = this.project(vault, id).head;
      if (head !== snapshot.parentRevision) throw new CloudError(409, "Cloud changed; preserve local snapshot and resolve conflict");
      const revision = head + 1; blob = `${randomUUID()}.gz`;
      atomicWrite(join(this.directory, "blobs", blob), bytes);
      this.db.prepare("insert into revisions(project_id,revision,fingerprint,checksum,blob,created_at,checkout_id,installation_id) values(?,?,?,?,?,?,?,?)").run(id, revision, snapshot.fingerprint, checksum, blob, this.now(), snapshot.checkoutId ?? null, snapshot.installationId);
      this.db.prepare("insert into uploads values(?,?,?,?)").run(id, uploadId, checksum, revision);
      this.db.prepare("update projects set head=? where id=?").run(revision, id);
      const old = this.db.prepare("select blob from revisions where project_id=? and revision<=?").all(id, revision - 5) as Array<{ blob: string }>;
      this.db.prepare("delete from revisions where project_id=? and revision<=?").run(id, revision - 5);
      this.db.exec("commit");
      for (const r of old) rmSync(join(this.directory, "blobs", r.blob), { force: true });
      return { revision, fingerprint: snapshot.fingerprint, checksum };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("rollback");
      // Committed blobs must survive post-commit cleanup failures.
      if (blob && !this.db.prepare("select 1 from revisions where blob=?").get(blob)) rmSync(join(this.directory, "blobs", blob), { force: true });
      throw error;
    }
  }
}
async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > limit) throw new CloudError(413, "Request too large"); parts.push(bytes); }
  return Buffer.concat(parts);
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
export function createCloudHttpServer(service: CloudService) {
  let uploading = false;
  return createServer({ requestTimeout: 300000, headersTimeout: 15000, maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      if (req.url === "/health" && req.method === "GET") { json(res, 200, { ok: true }); return; }
      const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const vault = service.authenticate(secret);
      const path = (req.url ?? "").split("?")[0]!;
      if (path === "/v1/vault" && req.method === "GET") { json(res, 200, { vaultId: vault.id, expiresAt: vault.expires_at, serverReadable: true }); return; }
      if (path === "/v1/projects") {
        if (req.method === "GET") { json(res, 200, service.db.prepare("select id,name,head from projects where vault_id=?").all(vault.id)); return; }
        if (req.method === "POST") {
          const input = z.object({ name: z.string().trim().min(1).max(120) }).parse(JSON.parse((await body(req, 4096)).toString()));
          service.authenticate(secret);
          const count = service.db.prepare("select count(*) as n from projects where vault_id=?").get(vault.id) as { n: number };
          if (count.n >= 10) throw new CloudError(409, "Beta project limit reached");
          const id = randomUUID(); service.db.prepare("insert into projects(id,vault_id,name) values(?,?,?)").run(id, vault.id, input.name); json(res, 201, { id, name: input.name, head: 0 }); return;
        }
      }
      const match = /^\/v1\/projects\/([^/]+)(?:\/(head|snapshots)(?:\/([^/]+))?)?$/.exec(path);
      if (!match) throw new CloudError(404, "Not found");
      const id = match[1]!; service.project(vault, id);
      if (!match[2] && req.method === "DELETE") { service.removeProject(id); json(res, 200, { deleted: true }); return; }
      if (match[2] === "head" && req.method === "GET") { json(res, 200, service.head(vault, id)); return; }
      if (match[2] === "snapshots" && match[3] && req.method === "PUT") {
        if (uploading) throw new CloudError(503, "Another snapshot upload is active; retry shortly");
        uploading = true;
        try {
          const bytes = await body(req, MAX_COMPRESSED); service.authenticate(secret);
          json(res, 200, service.publish(vault, id, match[3], bytes, String(req.headers["x-content-sha256"] ?? "")));
        } finally { uploading = false; }
        return;
      }
      if (match[2] === "snapshots" && match[3] && req.method === "GET") {
        const revision = z.coerce.number().int().positive().parse(match[3]);
        const row = service.db.prepare("select blob,checksum from revisions where project_id=? and revision=?").get(id, revision) as { blob: string; checksum: string } | undefined;
        if (!row) throw new CloudError(404, "Snapshot not retained");
        const bytes = readFileSync(join(service.directory, "blobs", row.blob));
        res.writeHead(200, { "content-type": "application/octet-stream", "x-content-sha256": row.checksum, "cache-control": "no-store" }); res.end(bytes); return;
      }
      throw new CloudError(405, "Method not allowed");
    })().catch(error => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      json(res, error instanceof CloudError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof CloudError ? error.message : "Request validation or storage failed" });
    });
  });
}
export function isCloudServiceEntrypoint(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argvPath);
  } catch {
    return importMetaUrl === pathToFileURL(argvPath).href;
  }
}

if (isCloudServiceEntrypoint(import.meta.url, process.argv[1])) {
  const [command = "serve", directory = "/var/lib/code-butler-cloud", id, days] = process.argv.slice(2);
  const service = new CloudService(directory);
  if (command === "serve") {
    service.maintenance();
    const server = createCloudHttpServer(service); server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1");
    const timer = setInterval(() => { try { service.maintenance(); } catch { console.error("Cloud maintenance failed"); } }, DAY); timer.unref();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => { clearInterval(timer); service.close(); }));
  } else {
    try {
      if (command === "issue") console.log(JSON.stringify(service.issue()));
      else if (command === "list") console.log(JSON.stringify(service.list()));
      else if (command === "extend") service.extend(id ?? "", days ? Number(days) : 185);
      else if (command === "revoke") service.revoke(id ?? "");
      else if (command === "prune") service.maintenance();
      else throw new Error("Usage: cloud service <serve|issue|list|extend|revoke|prune> <data-dir> [vault-id] [days]");
    } finally { service.close(); }
  }
}
