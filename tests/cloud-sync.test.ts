import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CloudService, createCloudHttpServer, isCloudServiceEntrypoint } from "../src/cloud/service.js";
import { cloudSync, projectOperation, request } from "../src/cloud/client.js";
import { runCloudCommand } from "../src/cloud/cli.js";
import { applySnapshot, captureSnapshot, decodeSnapshot, portableConfig, validArchivePath, recoverApply } from "../src/cloud/snapshot.js";
import { atomicJson, binding, connectionPath, saveBinding, sha256, stateDirectory } from "../src/cloud/state.js";
import { assertNoDatabaseHandles, withProjectGate } from "../src/cloud/gate.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = []; const services: CloudService[] = []; const servers: ReturnType<typeof createCloudHttpServer>[] = [];
const temp = () => { const p = makeTempDir(); roots.push(p); return p; };
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } for (const s of services.splice(0)) s.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const p of roots.splice(0)) cleanupTempDir(p); });
function initialize(root: string) { const s = openConfiguredMemoryStore(root); s.init(); s.close(); }
function remember(root: string, text: string) { const s = openConfiguredMemoryStore(root); try { s.init(); return rememberProjectMemory(s, { type: "decision", text }).memory!; } finally { s.close(); } }
async function fixture() {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const service = new CloudService(temp()); services.push(service);
  const access = service.issue(); const server = createCloudHttpServer(service); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  atomicJson(connectionPath(), { server: origin, secret: access.secret, vaultId: access.vaultId });
  const a = temp(), b = temp(); initialize(a); initialize(b);
  return { service, access, origin, a, b };
}
it("enforces isolation, 185-day expiry, extension and revocation", () => {
  let now = Date.now(); const service = new CloudService(temp(), () => now); services.push(service);
  const a = service.issue(), b = service.issue();
  expect(a.expiresAt - now).toBe(185 * 86400000);
  expect(JSON.stringify(service.list())).not.toContain(a.secret);
  const id = randomUUID(); service.db.prepare("insert into projects(id,vault_id,name) values(?,?,?)").run(id, a.vaultId, "private");
  expect(() => service.project(service.authenticate(b.secret), id)).toThrow("Project not found");
  now = a.expiresAt; expect(() => service.authenticate(a.secret)).toThrow("expired");
  service.extend(a.vaultId); expect(service.authenticate(a.secret).id).toBe(a.vaultId);
  service.revoke(a.vaultId); expect(() => service.authenticate(a.secret)).toThrow("revoked");
});

it("recognizes symlinked cloud service entrypoints", () => {
  const root = temp();
  const real = join(root, "releases", "service.js");
  const linked = join(root, "current", "service.js");
  mkdirSync(join(root, "releases"), { recursive: true });
  mkdirSync(join(root, "current"), { recursive: true });
  writeFileSync(real, "");
  rmSync(linked, { force: true });
  symlinkSync(real, linked);
  expect(isCloudServiceEntrypoint(pathToFileURL(real).href, linked)).toBe(true);
});
it("migrates existing cloud revision tables to store writer identity", () => {
  const dir = temp();
  const db = new DatabaseSync(join(dir, "cloud.sqlite"));
  try {
    db.exec(`create table vaults(id text primary key, secret_hash text unique not null, issued_at integer not null, expires_at integer not null, revoked integer not null default 0);
      create table projects(id text primary key, vault_id text not null references vaults(id), name text not null, head integer not null default 0);
      create table revisions(project_id text not null references projects(id) on delete cascade, revision integer not null, fingerprint text not null, checksum text not null, blob text not null, created_at integer not null, primary key(project_id,revision));
      create table uploads(project_id text not null references projects(id) on delete cascade, upload_id text not null, checksum text not null, revision integer not null, primary key(project_id,upload_id));`);
  } finally {
    db.close();
  }
  const service = new CloudService(dir); services.push(service);
  const columns = (service.db.prepare("pragma table_info(revisions)").all() as Array<{ name: string }>).map(column => column.name);
  expect(columns).toEqual(expect.arrayContaining(["checkout_id", "installation_id"]));
});
it("uses longer client timeouts for snapshot transfers", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const conn = { server: "https://cloud.example.test", secret: "a".repeat(43), vaultId: randomUUID() };
  await request(conn, "/v1/projects", "GET");
  expect(timeout).toHaveBeenLastCalledWith(30000);
  await request(conn, `/v1/projects/${randomUUID()}/snapshots/${randomUUID()}`, "PUT", Buffer.from("snapshot"));
  expect(timeout).toHaveBeenLastCalledWith(300000);
});
it("snapshots retain memories and origins while excluding local settings, secrets, logs and journals", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const saved = remember(a, "Use SQLite to preserve offline project history.");
  writeFileSync(join(a, ".code-butler", ".env"), "SECRET=private");
  mkdirSync(join(a, ".code-butler", "logs")); writeFileSync(join(a, ".code-butler", "logs", "secret.log"), "private");
  const first = await captureSnapshot(a, randomUUID(), 0);
  expect(first.snapshot.files.some(f => f.path === ".env" || f.path.startsWith("logs/"))).toBe(false);
  expect(portableConfig({ extractor: { baseUrl: "http://secret" }, sources: { git: { repoPath: a, enabled: true } } })).toEqual({ sources: { git: { enabled: true } } });
  expect(decodeSnapshot(first.bytes).fingerprint).toBe(first.snapshot.fingerprint);
  const second = await captureSnapshot(a, first.snapshot.projectId, 0); expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
  const b = temp(); initialize(b); applySnapshot(b, first.snapshot);
  const s = openConfiguredMemoryStore(b); try { s.init(); expect(s.readMemory(saved.id)!.origin).toEqual(saved.origin); } finally { s.close(); }
});
it("round-trips two devices, does not echo pulls, and preserves conflicting edits", async () => {
  const { a, b } = await fixture(); const saved = remember(a, "Keep storage local for offline usage.");
  await runCloudCommand(["enable"], a, () => {});
  const id = binding(a)!.projectId;
  await runCloudCommand(["enable", "--project", id], b, () => {});
  const restored = openConfiguredMemoryStore(b); try { restored.init(); expect(restored.readMemory(saved.id)).toBeDefined(); } finally { restored.close(); }
  const revision = binding(b)!.revision;
  await cloudSync(b); expect(binding(b)!.revision).toBe(revision);
  remember(a, "Use explicit lifecycle replacement when correcting prior decisions."); await cloudSync(a);
  remember(b, "Preserve all evidence when correcting project decisions.");
  await cloudSync(b); expect(binding(b)!.status).toBe("conflict");
  expect(existsSync(join(stateDirectory(b), "conflict-cloud.gz"))).toBe(true);
  const cloudRevision = binding(a)!.revision;
  await runCloudCommand(["resolve", "--keep", "local"], b, () => {});
  expect(binding(b)!.revision).toBe(cloudRevision + 1);
  expect(existsSync(join(stateDirectory(b), "conflict-local.gz"))).toBe(true);
});
it("fast-forwards same-checkout cloud revisions instead of creating a conflict", async () => {
  const { service, access, a } = await fixture();
  remember(a, "Keep local MCP and watcher processes attached to one checkout identity.");
  await runCloudCommand(["enable"], a, () => {});
  const stale = binding(a)!;
  expect(stale.checkoutId).toMatch(/^[0-9a-f-]{36}$/);
  remember(a, "A background process can publish a cloud revision first.");
  const remote = await captureSnapshot(a, stale.projectId, stale.revision, stale.checkoutId);
  const published = service.publish(service.authenticate(access.secret), stale.projectId, randomUUID(), remote.bytes, sha256(remote.bytes)) as { revision: number };
  expect(published.revision).toBe(stale.revision + 1);
  expect(binding(a)!.revision).toBe(stale.revision);
  remember(a, "The current process may have newer local memory after that publish.");
  const synced = await cloudSync(a);
  expect(synced).toMatchObject({ status: "synced", revision: published.revision + 1 });
  expect(binding(a)!.status).toBe("synced");
});
it("recovers when a pending upload reached cloud before local state was saved", async () => {
  const { service, access, a } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  const stale = binding(a)!;
  remember(a, "A pending upload may succeed before the client records the revision.");
  const pending = await captureSnapshot(a, stale.projectId, stale.revision, stale.checkoutId);
  const uploadId = randomUUID();
  const published = service.publish(service.authenticate(access.secret), stale.projectId, uploadId, pending.bytes, sha256(pending.bytes)) as { revision: number };
  service.db.prepare("update revisions set checkout_id=null where project_id=? and revision=?").run(stale.projectId, published.revision);
  saveBinding(a, { ...stale, pending: { uploadId, fingerprint: pending.snapshot.fingerprint, parentRevision: stale.revision } });
  remember(a, "More local memory can be added before retrying the pending upload.");
  const synced = await cloudSync(a);
  expect(synced).toMatchObject({ status: "synced", revision: published.revision + 1 });
  expect(binding(a)!.pending).toBeUndefined();
});
it("handles idempotent uploads, rejects stale revisions, and retains five versions", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const service = new CloudService(temp()); services.push(service);
  const auth = service.issue(); const vault = service.authenticate(auth.secret); const id = randomUUID();
  service.db.prepare("insert into projects(id,vault_id,name) values(?,?,?)").run(id, vault.id, "project");
  const a = temp(); initialize(a); const first = await captureSnapshot(a, id, 0); const upload = randomUUID();
  const one = service.publish(vault, id, upload, first.bytes, sha256(first.bytes));
  expect(service.publish(vault, id, upload, first.bytes, sha256(first.bytes))).toEqual(one);
  expect(() => service.publish(vault, id, randomUUID(), first.bytes, sha256(first.bytes))).toThrow("Cloud changed");
  for (let rev = 1; rev < 7; rev++) { const next = await captureSnapshot(a, id, rev); service.publish(vault, id, randomUUID(), next.bytes, sha256(next.bytes)); }
  expect(service.db.prepare("select count(*) as n from revisions").get()).toEqual({ n: 5 });
});
it("validates hostile paths and rejects unsafe restores while a database is open", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  for (const path of ["../secret", "/etc/config", "a\\b", "C:/secret"]) expect(() => validArchivePath(path)).toThrow();
  for (const path of ["CON.txt", "file.", "a:b"]) expect(() => validArchivePath(path, "win32")).toThrow();
  const snapshot = await captureSnapshot(a, randomUUID(), 0);
  const open = openConfiguredMemoryStore(a); try { open.init(); expect(() => applySnapshot(a, snapshot.snapshot)).toThrow("deferred"); } finally { open.close(); }
  expect(() => assertNoDatabaseHandles(a)).not.toThrow();
});
it("serializes operations and recovers an interrupted apply before opening a store", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const order: number[] = [];
  await Promise.all([withProjectGate(a, async () => { order.push(1); await new Promise(r => setTimeout(r, 50)); order.push(2); }), withProjectGate(a, () => { order.push(3); })]);
  expect(order).toEqual([1, 2, 3]);
  const original = readFileSync(join(a, ".code-butler", "memory.sqlite"));
  atomicJson(join(stateDirectory(a), "apply-journal.json"), { files: [{ path: "memory.sqlite", data: original.toString("base64") }], incoming: ["memory.sqlite"] });
  writeFileSync(join(a, ".code-butler", "memory.sqlite"), "partial");
  await projectOperation(a, () => initialize(a));
  expect(existsSync(join(stateDirectory(a), "apply-journal.json"))).toBe(false);
});

it("keeps MCP transport usable across cloud restore with fresh bounded stores", async () => {
  const { a, b } = await fixture();
  // Prevent unrelated local source ingestion from changing this transport fixture.
  for (const root of [a, b]) {
    const path = join(root, ".code-butler", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")); config.sync = { ...config.sync, autoSyncOnServerStart: false }; writeFileSync(path, JSON.stringify(config));
  }
  remember(a, "Use SQLite to keep project history available offline.");
  await runCloudCommand(["enable"], a, () => {});
  await runCloudCommand(["enable", "--project", binding(a)!.projectId], b, () => {});
  const { createProjectMemoryServer, closeProjectMemoryServer } = await import("../src/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const project = await createProjectMemoryServer(b);
  const client = new Client({ name: "cloud-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await project.server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const before = await client.callTool({ name: "find_memories", arguments: { query: "SQLite" } });
    expect(JSON.stringify(before)).toContain("SQLite");
    const added = remember(a, "Preserve rejected alternatives for future architecture reviews."); await cloudSync(a);
    await cloudSync(b);
    const after = await client.callTool({ name: "find_memories", arguments: { query: "rejected alternatives" } });
    expect(JSON.stringify(after)).toContain(added.id);
    const saved = await client.callTool({ name: "remember_project_memory", arguments: { type: "constraint", text: "Keep all core memory operations usable without external APIs." } });
    expect(JSON.stringify(saved)).toContain("cloud-test");
  } finally { await client.close(); await closeProjectMemoryServer(project); }
});

it("keeps remote snapshots through grace, then removes them, and enforces the project quota", async () => {
  const { service, origin, access, a } = await fixture();
  const auth = { authorization: `Bearer ${access.secret}`, "content-type": "application/json" };
  for (let i = 0; i < 10; i++) expect((await fetch(`${origin}/v1/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: `p${i}` }) })).status).toBe(201);
  expect((await fetch(`${origin}/v1/projects`, { method: "POST", headers: auth, body: '{"name":"extra"}' })).status).toBe(409);
  service.db.prepare("update vaults set expires_at=? where id=?").run(Date.now() - 29 * 86400000, access.vaultId); service.maintenance();
  expect(service.db.prepare("select count(*) as n from projects").get()).toEqual({ n: 10 });
  service.db.prepare("update vaults set expires_at=? where id=?").run(Date.now() - 31 * 86400000, access.vaultId); service.maintenance();
  expect(service.db.prepare("select count(*) as n from projects").get()).toEqual({ n: 0 });
  expect((await fetch(`${origin}/v1/projects`, { headers: auth })).status).toBe(403);
  expect(() => remember(a, "Local memory remains writable after cloud access expires.")).not.toThrow();
});

it("preserves receiving-device cursors, endpoints, roots, and temporary expiry", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(), b = temp(); initialize(a); initialize(b);
  const source = openConfiguredMemoryStore(a);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  try { source.init(); source.upsertTemporaryMemory({ title: "Current task", summary: "Finish portability tests", kind: "task_state", expiresAt }); } finally { source.close(); }
  const path = join(b, ".code-butler", "config.json"); const localConfig = JSON.parse(readFileSync(path, "utf8"));
  localConfig.extractor = { provider: "openai-compatible", baseUrl: "http://localhost:8080", model: "local", apiKeyEnv: "LOCAL_KEY" };
  localConfig.sources.git.repoPath = b; localConfig.sources.codex.roots = ["C:/local/sessions"];
  writeFileSync(path, JSON.stringify(localConfig));
  const target = openConfiguredMemoryStore(b);
  try { target.init(); target.db.prepare("insert into sync_cursors(source,cursor_key,cursor_value,updated_at) values('codex','local','7','now')").run(); } finally { target.close(); }
  const snapshot = await captureSnapshot(a, randomUUID(), 0); applySnapshot(b, snapshot.snapshot);
  const restoredConfig = JSON.parse(readFileSync(path, "utf8")); expect(restoredConfig.extractor).toEqual(localConfig.extractor); expect(restoredConfig.sources.codex.roots).toEqual(["C:/local/sessions"]);
  const restored = openConfiguredMemoryStore(b);
  try { restored.init(); expect(restored.db.prepare("select cursor_value from sync_cursors").get()).toEqual({ cursor_value: "7" }); expect(restored.listActiveTemporaryMemory()[0]).toMatchObject({ projectId: b, expiresAt }); } finally { restored.close(); }
});

it("rejects corrupted checksums, future schemas, and archive path collisions", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const { gzipSync } = await import("node:zlib"); const captured = await captureSnapshot(a, randomUUID(), 0);
  const encode = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));
  expect(() => decodeSnapshot(encode({ ...captured.snapshot, schemaVersion: 999 }))).toThrow();
  const broken = structuredClone(captured.snapshot); broken.files[0]!.checksum = "0".repeat(64);
  expect(() => decodeSnapshot(encode(broken))).toThrow("checksum");
  const duplicate = structuredClone(captured.snapshot); duplicate.files.push(duplicate.files[0]!);
  expect(() => decodeSnapshot(encode(duplicate))).toThrow("colliding");
});

it("automatically uploads settled changes and pulls remote revisions while running", async () => {
  const { a, b } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  await runCloudCommand(["enable", "--project", binding(a)!.projectId], b, () => {});
  const { startCloudScheduler } = await import("../src/cloud/client.js");
  const warnings: string[] = [];
  const stopA = startCloudScheduler(a, m => warnings.push(m), { tickMs: 10, settleMs: 20, pollMs: 100 });
  const stopB = startCloudScheduler(b, m => warnings.push(m), { tickMs: 10, settleMs: 20, pollMs: 100 });
  const initial = binding(a)!.revision;
  try {
    const added = remember(a, "Synchronize project decisions automatically after local work settles.");
    await vi.waitFor(() => { expect(binding(a)!.revision).toBeGreaterThan(initial); expect(binding(b)!.revision).toBe(binding(a)!.revision); }, { timeout: 5000, interval: 100 });
    await projectOperation(b, () => {
      const s = openConfiguredMemoryStore(b); try { s.init(); expect(s.readMemory(added.id)).toBeDefined(); } finally { s.close(); }
    });
    expect(warnings).toEqual([]);
  } finally { stopA(); stopB(); await new Promise(r => setTimeout(r, 100)); }
});

it("reclaims a dead process gate without admitting concurrent operations", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const { spawn } = await import("node:child_process"); const { pathToFileURL } = await import("node:url"); const { resolve } = await import("node:path");
  const script = `import { withProjectGate } from ${JSON.stringify(pathToFileURL(resolve("src/cloud/gate.ts")).href)}; await withProjectGate(process.argv[1], async () => { console.log("locked"); await new Promise(r => setTimeout(r, 30000)); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, a], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Child exited before taking the gate")));
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    const order: number[] = [];
    await Promise.all([withProjectGate(a, async () => { order.push(1); await new Promise(r => setTimeout(r, 20)); order.push(2); }), withProjectGate(a, () => { order.push(3); })]);
    expect(order).toEqual([1, 2, 3]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

it("makes consistent snapshots while another connection commits changes", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const writer = openConfiguredMemoryStore(a); writer.init();
  let n = 0;
  const timer = setInterval(() => {
    const id = `concurrent-${n++}`;
    writer.addSourceWithChunks({ source: { id, type: "conversation", title: id, origin: "test", rawContent: "complete evidence" }, chunks: [{ text: "complete evidence" }] });
  }, 1);
  try {
    const capture = await captureSnapshot(a, randomUUID(), 0);
    expect(decodeSnapshot(capture.bytes).files.some(f => f.path === "memory.sqlite")).toBe(true);
  } finally { clearInterval(timer); writer.close(); }
});
