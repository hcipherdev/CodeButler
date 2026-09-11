import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CloudService, createCloudHttpServer, isCloudServiceEntrypoint } from "../src/cloud/service.js";
import { cloudSync, projectOperation, request } from "../src/cloud/client.js";
import { runCloudCommand } from "../src/cloud/cli.js";
import {
  applySnapshot,
  bundleResolver,
  captureSnapshot,
  coreSegment,
  decodeSnapshot,
  materializeSnapshot,
  portableConfig,
  segmentPath,
  validArchivePath,
  recoverApply,
  type CaptureResult
} from "../src/cloud/snapshot.js";
import { atomicJson, binding, connectionPath, saveBinding, sha256, stateDirectory } from "../src/cloud/state.js";
import { assertNoDatabaseHandles, withProjectGate } from "../src/cloud/gate.js";
import { openConfiguredMemoryStore } from "../src/storage/open-configured-store.js";
import { rememberProjectMemory } from "../src/memory/remember.js";
import { updateMemoryLayer } from "../src/memory/layer-service.js";
import { updateMemoryStatus } from "../src/memory/lifecycle-service.js";
import { deviceLayer, layerLabel } from "../src/memory/layer.js";
import { applyAutomaticPromotion, planAutomaticPromotions } from "../src/memory/automatic-promotion.js";
import type { ProjectConfig } from "../src/types.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

function promotionConfig(repoPath: string): ProjectConfig {
  return {
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2,
      automatic: { enabled: true, mode: "conservative", minScore: 0.85, mergedBranches: true, deviceMemories: true }
    },
    sources: { git: { repoPath } }
  } as unknown as ProjectConfig;
}

/** Creates a repo whose feature branch is merged into main, so triage reports `merged`. */
function initMergedBranchRepo(root: string, branch: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "# test\n");
  run(["add", "README.md"]);
  run(["commit", "-m", "Initial commit"]);
  run(["branch", "-M", "main"]);
  run(["checkout", "-b", branch]);
  writeFileSync(join(root, "feature.md"), "# feature\n");
  run(["add", "feature.md"]);
  run(["commit", "-m", "Add feature"]);
  run(["checkout", "main"]);
  run(["merge", "--no-ff", "-m", "Merge feature", branch]);
}

/** A manifest may only be published once every block it references is stored. */
function publishCapture(
  service: CloudService,
  vault: ReturnType<CloudService["authenticate"]>,
  projectId: string,
  uploadId: string,
  capture: CaptureResult
): { revision: number } {
  for (const [checksum, data] of capture.blocks) service.storeSegment(vault, projectId, checksum, gzipSync(data));
  return service.publish(vault, projectId, uploadId, capture.bytes, sha256(capture.bytes)) as { revision: number };
}
/** Payloads now travel as blocks, so applying a capture means materializing it first. */
function applyCapture(root: string, capture: CaptureResult): void {
  applySnapshot(root, materializeSnapshot(capture.snapshot, bundleResolver(capture.blocks)));
}
function snapshotPaths(manifest: CaptureResult["snapshot"]): string[] {
  return manifest.segments.map(segmentPath);
}

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
it("retries an idempotent request once when a keep-alive socket is reset", async () => {
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  const responses = vi.fn()
    .mockRejectedValueOnce(reset)
    .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 3 }), { status: 200 }));
  vi.stubGlobal("fetch", responses);
  const conn = { server: "https://cloud.example.test", secret: "a".repeat(43), vaultId: randomUUID() };

  expect(await (await request(conn, "/v1/projects/id/head")).json()).toEqual({ revision: 3 });
  expect(responses).toHaveBeenCalledTimes(2);

  // A second reset is a real outage, not a lost socket.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(reset));
  await expect(request(conn, "/v1/projects/id/head")).rejects.toThrow("Cloud unavailable");
  // A refusal from the service itself is never retried.
  const refused = vi.fn(async () => new Response("no", { status: 401 }));
  vi.stubGlobal("fetch", refused);
  await expect(request(conn, "/v1/projects/id/head")).rejects.toThrow("Beta code invalid or revoked");
  expect(refused).toHaveBeenCalledTimes(1);
});

it("includes cloud error response details", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Snapshot schema version mismatch" }), { status: 400 })));
  const conn = { server: "https://cloud.example.test", secret: "a".repeat(43), vaultId: randomUUID() };
  await expect(request(conn, "/v1/projects/id/head")).rejects.toThrow("Snapshot schema version mismatch");
});
it("snapshots retain memories and origins while excluding local settings, secrets, logs and journals", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const saved = remember(a, "Use SQLite to preserve offline project history.");
  writeFileSync(join(a, ".code-butler", ".env"), "SECRET=private");
  writeFileSync(join(a, ".code-butler", "config.local.json"), JSON.stringify({ sources: { git: { repoPath: a } } }));
  mkdirSync(join(a, ".code-butler", "logs")); writeFileSync(join(a, ".code-butler", "logs", "secret.log"), "private");
  const first = await captureSnapshot(a, randomUUID(), 0);
  expect(snapshotPaths(first.snapshot).some(path => path === ".env" || path === "config.local.json" || path.startsWith("logs/"))).toBe(false);
  expect(readdirSync(stateDirectory(a)).filter(name => name.startsWith("capture-"))).toEqual([]);
  expect(portableConfig({ extractor: { baseUrl: "http://secret" }, sources: { git: { repoPath: a, enabled: true } } })).toEqual({ sources: { git: { enabled: true } } });
  expect(decodeSnapshot(first.bytes).fingerprint).toBe(first.snapshot.fingerprint);
  const second = await captureSnapshot(a, first.snapshot.projectId, 0); expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
  const b = temp(); initialize(b); applyCapture(b, first);
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
  const published = publishCapture(service, service.authenticate(access.secret), stale.projectId, randomUUID(), remote);
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
  const published = publishCapture(service, service.authenticate(access.secret), stale.projectId, uploadId, pending);
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
  const one = publishCapture(service, vault, id, upload, first);
  expect(publishCapture(service, vault, id, upload, first)).toEqual(one);
  expect(() => publishCapture(service, vault, id, randomUUID(), first)).toThrow("Cloud changed");
  for (let rev = 1; rev < 7; rev++) { const next = await captureSnapshot(a, id, rev); publishCapture(service, vault, id, randomUUID(), next); }
  expect(service.db.prepare("select count(*) as n from revisions").get()).toEqual({ n: 5 });
});
it("validates hostile paths and rejects unsafe restores while a database is open", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  for (const path of ["../secret", "/etc/config", "a\\b", "C:/secret"]) expect(() => validArchivePath(path)).toThrow();
  for (const path of ["CON.txt", "file.", "a:b"]) expect(() => validArchivePath(path, "win32")).toThrow();
  const snapshot = await captureSnapshot(a, randomUUID(), 0);
  const open = openConfiguredMemoryStore(a); try { open.init(); expect(() => applyCapture(a, snapshot)).toThrow("deferred"); } finally { open.close(); }
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

it("preserves receiving-device cursors, endpoints, roots, and its own working context", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(), b = temp(); initialize(a); initialize(b);
  const source = openConfiguredMemoryStore(a);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  try { source.init(); source.upsertTemporaryMemory({ title: "Sender task", summary: "Finish portability tests", kind: "task_state", expiresAt }); } finally { source.close(); }
  const path = join(b, ".code-butler", "config.json"); const localConfig = JSON.parse(readFileSync(path, "utf8"));
  localConfig.extractor = { provider: "openai-compatible", baseUrl: "http://localhost:8080", model: "local", apiKeyEnv: "LOCAL_KEY" };
  localConfig.sources.git.repoPath = b; localConfig.sources.codex.roots = ["C:/local/sessions"];
  writeFileSync(path, JSON.stringify(localConfig));
  const localExpiresAt = new Date(Date.now() + 7200000).toISOString();
  const target = openConfiguredMemoryStore(b);
  try {
    target.init();
    target.db.prepare("insert into sync_cursors(source,cursor_key,cursor_value,updated_at) values('codex','local','7','now')").run();
    target.upsertTemporaryMemory({ title: "Receiver task", summary: "Keep local working context", kind: "task_state", expiresAt: localExpiresAt });
  } finally { target.close(); }
  const snapshot = await captureSnapshot(a, randomUUID(), 0); applyCapture(b, snapshot);
  const restoredConfig = JSON.parse(readFileSync(path, "utf8")); expect(restoredConfig.extractor).toEqual(localConfig.extractor); expect(restoredConfig.sources.codex.roots).toEqual(["C:/local/sessions"]);
  const restored = openConfiguredMemoryStore(b);
  try {
    restored.init();
    expect(restored.db.prepare("select cursor_value from sync_cursors").get()).toEqual({ cursor_value: "7" });
    // Working context is device-layered, so the sender's never arrives and the receiver's survives.
    expect(restored.listActiveTemporaryMemory().map(m => m.title)).toEqual(["Receiver task"]);
    expect(restored.listActiveTemporaryMemory()[0]).toMatchObject({ projectId: b, expiresAt: localExpiresAt });
  } finally { restored.close(); }
});

it("rejects corrupted checksums, future schemas, and archive path collisions", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const captured = await captureSnapshot(a, randomUUID(), 0);
  const encode = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));
  expect(() => decodeSnapshot(encode({ ...captured.snapshot, schemaVersion: 999 }))).toThrow();
  // A file segment's content address and its fingerprint are the same hash, so a
  // rewritten fingerprint can never be assembled into a file that passes validation.
  const broken = structuredClone(captured.snapshot);
  broken.segments.find(segment => segment.kind === "file")!.fingerprint = "0".repeat(64);
  expect(() => decodeSnapshot(encode(broken))).toThrow("checksum");
  const duplicate = structuredClone(captured.snapshot); duplicate.segments.push(duplicate.segments[0]!);
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
    expect(segmentPath(coreSegment(decodeSnapshot(capture.bytes)))).toBe("memory.sqlite");
  } finally { clearInterval(timer); writer.close(); }
});

function rememberLayered(root: string, text: string, layer: string) {
  const s = openConfiguredMemoryStore(root);
  try { s.init(); return rememberProjectMemory(s, { type: "decision", text, layer }).memory!; } finally { s.close(); }
}
function snapshotDb<T>(capture: CaptureResult, read: (db: DatabaseSync) => T): T {
  const path = join(temp(), "snapshot.sqlite");
  const materialized = materializeSnapshot(capture.snapshot, bundleResolver(capture.blocks));
  writeFileSync(path, materialized.files.find(f => f.path === "memory.sqlite")!.data);
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

it("uploads only core memories and never device-layer content", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const shared = remember(a, "Adopt hybrid retrieval for project search.");
  const local = rememberLayered(a, "This laptop needs the vendored toolchain.", `device:${randomUUID()}`);
  const captured = await captureSnapshot(a, randomUUID(), 0);
  const contents = snapshotDb(captured, db => ({
    memories: db.prepare("select id, layer from memories order by id").all(),
    candidates: db.prepare("select count(*) as n from memory_candidates where layer <> 'core'").get(),
    temporary: db.prepare("select count(*) as n from temporary_memories where layer <> 'core'").get(),
    vectors: db.prepare("select count(*) as n from embedding_vectors").get(),
    localSources: db.prepare("select count(*) as n from sources where id like '%:layer:%'").get(),
    orphanChunks: db.prepare("select count(*) as n from chunks where source_id not in (select id from sources)").get()
  }));
  expect(contents.memories).toEqual([{ id: shared.id, layer: "core" }]);
  expect(contents.memories.map(m => m.id)).not.toContain(local.id);
  expect(contents.candidates).toEqual({ n: 0 });
  expect(contents.temporary).toEqual({ n: 0 });
  expect(contents.vectors).toEqual({ n: 0 });
  // The dedicated source row holds the memory's full text, so it must not travel either.
  expect(contents.localSources).toEqual({ n: 0 });
  expect(contents.orphanChunks).toEqual({ n: 0 });
});

it("delivers an automatically promoted memory to the second device exactly once", async () => {
  const { a, b } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  const projectId = binding(a)!.projectId;
  await runCloudCommand(["enable", "--project", projectId], b, () => {});

  // Device A holds a branch candidate plus its own local context; B holds only local context.
  const branchLayer = "branch:feature/cloud-promotion";
  initMergedBranchRepo(a, "feature/cloud-promotion");
  const localA = rememberLayered(a, "Device A uses the vendored toolchain.", `device:${randomUUID()}`);
  const localB = rememberLayered(b, "Device B keeps the staging credentials.", `device:${randomUUID()}`);
  const storeA = openConfiguredMemoryStore(a);
  let candidateId = "";
  try {
    storeA.init();
    candidateId = storeA.upsertMemoryCandidate({
      layer: branchLayer,
      type: "decision",
      title: "Token caching",
      summary: "The auth middleware caches tokens in Redis.",
      reason: "Found on the feature branch.",
      confidence: 0.95,
      scope: { kind: "project" },
      evidence: [],
      relatedFiles: [],
      dedupeKey: "cloud-auto-promotion"
    }, { qualityStatus: "active", qualityReasons: [] }).id;
    // Promote through the same planner and executor the sync pass uses.
    const plan = planAutomaticPromotions(storeA, promotionConfig(a), { repoPath: a });
    const decision = plan.decisions.find(item => item.memoryId === candidateId)!;
    expect(decision.decision).toBe("promote");
    applyAutomaticPromotion(storeA, decision, "system");
  } finally { storeA.close(); }

  await cloudSync(a);
  await cloudSync(b);

  const received = openConfiguredMemoryStore(b);
  try {
    received.init();
    // The promoted fact arrives exactly once.
    const promoted = received
      .listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null })
      .filter(memory => memory.summary === "The auth middleware caches tokens in Redis.");
    expect(promoted).toHaveLength(1);
    // Each device still keeps its own local context, and neither sees the other's.
    expect(received.readMemory(localB.id)?.layer).toContain("device:");
    expect(received.readMemory(localA.id)).toBeUndefined();
    // Decision records are device-local, so B receives none of A's.
    expect(received.db.prepare("select count(*) as n from promotion_decisions").get()).toEqual({ n: 0 });
  } finally { received.close(); }

  // A repeated sync on both sides adds nothing and raises no conflict.
  await cloudSync(a);
  await cloudSync(b);
  expect(binding(a)!.status).not.toBe("conflict");
  expect(binding(b)!.status).not.toBe("conflict");
  const again = openConfiguredMemoryStore(b);
  try {
    again.init();
    expect(again
      .listMemories({ layer: "core", lifecycleStatus: "current", qualityStatus: "all", limit: null })
      .filter(memory => memory.summary === "The auth middleware caches tokens in Redis.")).toHaveLength(1);
  } finally { again.close(); }
});

it("filters manual source rows by current layer instead of source id history", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const demotedLayer = `device:${randomUUID()}`;
  const promotedLayer = `device:${randomUUID()}`;
  const demoted = rememberLayered(a, "This shared-looking memory is local after review.", "core");
  const promoted = rememberLayered(a, "This local memory became a shared project rule.", promotedLayer);
  const s = openConfiguredMemoryStore(a);
  try {
    s.init();
    updateMemoryLayer(s, { memoryId: demoted.id, category: "promoted", layer: demotedLayer, reason: "Only applies locally." });
    updateMemoryLayer(s, { memoryId: promoted.id, category: "promoted", layer: "core", reason: "Confirmed shared." });
  } finally { s.close(); }
  const captured = await captureSnapshot(a, randomUUID(), 0);
  const contents = snapshotDb(captured, db => ({
    memories: db.prepare("select id, layer from memories order by id").all(),
    sources: db.prepare("select id from sources where id like 'manual-memory:%' order by id").all(),
    orphanChunks: db.prepare("select count(*) as n from chunks where source_id not in (select id from sources)").get(),
    orphanLinks: db.prepare("select count(*) as n from memory_links where target_id like 'manual-memory:%' and target_id not in (select id from sources)").get()
  }));
  expect(contents.memories).toEqual([{ id: promoted.id, layer: "core" }]);
  expect(contents.sources).toHaveLength(1);
  expect(contents.sources[0]!.id).toContain(":layer:");
  expect(contents.orphanChunks).toEqual({ n: 0 });
  expect(contents.orphanLinks).toEqual({ n: 0 });
});

it("keeps local layers across a restore and repairs references the sender dropped", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(), b = temp(); initialize(a); initialize(b);
  remember(a, "Adopt hybrid retrieval for project search.");
  const kept = rememberLayered(b, "Only this checkout has the staging credentials.", `device:${randomUUID()}`);
  // A local candidate promoted against a memory the sender never had: restoring must not
  // fail foreign_key_check, so the dangling pointer is cleared instead.
  const raw = new DatabaseSync(join(b, ".code-butler", "memory.sqlite"));
  try {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("update memory_candidates set promoted_memory_id = 'memory-missing' where promoted_memory_id = ?").run(kept.id);
  } finally { raw.close(); }
  applyCapture(b, await captureSnapshot(a, randomUUID(), 0));
  const restored = openConfiguredMemoryStore(b);
  try {
    restored.init();
    expect(restored.db.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(restored.readMemory(kept.id)).toBeDefined();
    expect(restored.db.prepare("select count(*) as n from memories where layer = 'core'").get()).toEqual({ n: 1 });
    expect(restored.db.prepare("select count(*) as n from memory_candidates where promoted_memory_id = 'memory-missing'").get()).toEqual({ n: 0 });
  } finally { restored.close(); }
});

it("does not push or conflict when only device layers change", async () => {
  const { a, b } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  await runCloudCommand(["enable", "--project", binding(a)!.projectId], b, () => {});
  remember(a, "Adopt hybrid retrieval for project search.");
  await cloudSync(a); await cloudSync(b);
  const revision = binding(a)!.revision;
  expect(binding(b)!.revision).toBe(revision);
  const fingerprint = binding(a)!.fingerprint;

  rememberLayered(a, "Device A keeps its own investigation notes.", `device:${randomUUID()}`);
  rememberLayered(b, "Device B keeps a different set of notes.", `device:${randomUUID()}`);
  await cloudSync(a); await cloudSync(b);

  // Device-layer writes leave the core fingerprint untouched, so neither side pushes.
  expect(binding(a)!.fingerprint).toBe(fingerprint);
  expect(binding(a)!.revision).toBe(revision);
  expect(binding(b)!.revision).toBe(revision);
  expect(binding(a)!.status).not.toBe("conflict");
  expect(binding(b)!.status).not.toBe("conflict");
});

it("uploads only the blocks a revision actually changed", async () => {
  const { service, a } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  remember(a, "Adopt hybrid retrieval for project search.");
  await cloudSync(a);
  const projectId = binding(a)!.projectId;
  const countBlocks = () => Number((service.db.prepare("select count(*) as n from segments where project_id=?").get(projectId) as { n: number }).n);
  const first = countBlocks();
  const baseRevision = binding(a)!.revision;
  expect(first).toBeGreaterThan(0);

  // A second revision re-sends only what changed, not the whole database.
  remember(a, "Prefer deterministic extraction for typed directives.");
  await cloudSync(a);
  const revision = binding(a)!.revision;
  expect(revision).toBe(baseRevision + 1);
  // The delta must be a small fraction of the whole, not merely smaller than it.
  const added = countBlocks() - first;
  expect(added).toBeGreaterThan(0);
  expect(added).toBeLessThan(first / 2);

  // Every block the head manifest references is stored, so the revision is complete.
  const segments = service.revisionSegments(projectId, revision);
  expect(segments.some(segment => segment.kind === "core")).toBe(true);
  for (const checksum of segments.flatMap(segment => segment.blocks)) {
    expect(service.hasSegment(projectId, checksum)).toBe(true);
  }
});

it("dedupes identical blocks, rejects a mismatched address, and drops unreferenced blocks", async () => {
  const { service, access, a } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  remember(a, "Adopt hybrid retrieval for project search.");
  await cloudSync(a);
  const projectId = binding(a)!.projectId;
  const vault = service.authenticate(access.secret);
  const block = Buffer.from("a repeated payload");
  const checksum = sha256(block);

  expect(service.storeSegment(vault, projectId, checksum, gzipSync(block))).toEqual({ checksum, stored: true });
  // Content addressing makes a re-send free rather than a duplicate.
  expect(service.storeSegment(vault, projectId, checksum, gzipSync(block))).toEqual({ checksum, stored: false });
  expect(() => service.storeSegment(vault, projectId, "0".repeat(64), gzipSync(block))).toThrow("checksum mismatch");
  expect(() => service.storeSegment(vault, projectId, checksum, block)).toThrow("encoding");

  // The block belongs to no revision, so maintenance reclaims it.
  expect(service.hasSegment(projectId, checksum)).toBe(true);
  service.maintenance();
  expect(service.hasSegment(projectId, checksum)).toBe(false);
  const segments = service.revisionSegments(projectId, binding(a)!.revision);
  for (const referenced of segments.flatMap(segment => segment.blocks)) {
    expect(service.hasSegment(projectId, referenced)).toBe(true);
  }
});

it("resumes an interrupted publish from the retained pending bundle without a duplicate revision", async () => {
  const { service, a } = await fixture();
  await runCloudCommand(["enable"], a, () => {});
  remember(a, "Adopt hybrid retrieval for project search.");
  await cloudSync(a);
  const projectId = binding(a)!.projectId;
  const revision = binding(a)!.revision;

  // The manifest reached cloud but local state was never saved: the retained bundle
  // must replay the same upload id and converge on the existing revision.
  remember(a, "Prefer deterministic extraction for typed directives.");
  const state = binding(a)!;
  await cloudSync(a);
  expect(binding(a)!.revision).toBe(revision + 1);
  const published = binding(a)!.revision;
  saveBinding(a, { ...state, revision, fingerprint: state.fingerprint, status: "offline-or-deferred" });
  await cloudSync(a);
  expect(binding(a)!.revision).toBe(published);
  expect(binding(a)!.status).toBe("synced");
  expect(Number((service.db.prepare("select count(*) as n from revisions where project_id=?").get(projectId) as { n: number }).n)).toBe(published);
});

it("rejects a snapshot from a client that predates memory layers", async () => {
  vi.stubEnv("CODE_BUTLER_HOME", temp()); const a = temp(); initialize(a);
  const { snapshot } = await captureSnapshot(a, randomUUID(), 0);
  const legacy = gzipSync(Buffer.from(JSON.stringify({ ...snapshot, version: 1 })));
  expect(() => decodeSnapshot(legacy)).toThrow();
});
