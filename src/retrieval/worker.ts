import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { backup } from "node:sqlite";
import { cloudSync, projectOperation } from "../cloud/client.js";
import { withProjectGate } from "../cloud/gate.js";
import { loadProjectConfig } from "../config.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { openMemoryStore, type MemoryStore } from "../storage/store.js";
import { createRedactionPolicy } from "../privacy/policy.js";
import { publicationPrivacyMatches, publishRetrieval, refreshPublishedFiles, withPublishedIndex } from "./index.js";
import { retrievalEpoch, retrievalPaths, retrievalPolicy } from "./paths.js";
import { DatabaseSync } from "node:sqlite";
import { readPublication } from "./index.js";
import { createProjectMemoryToolHandlers } from "../mcp/tools.js";
import { ensureAutomaticProjectSetup, enrichLocalProjectSummary } from "../project-setup.js";
interface Capture {
    directory: string;
    root: string;
    identity: string;
    epoch: string;
}
/** Snapshot acquisition is separate from assessment and publication. */
export async function captureRetrieval(store: MemoryStore): Promise<Capture> {
    const root = store.paths.rootDir;
    const paths = retrievalPaths(root);
    mkdirSync(paths.directory, { recursive: true });
    const directory = mkdtempSync(join(paths.directory, "capture-"));
    mkdirSync(join(directory, ".code-butler"));
    const epoch = retrievalEpoch(root);
    let identity: string;
    try {
        const ownCanonical = !store.db.isTransaction;
        const ownLocal = !store.localDb.isTransaction;
        try {
            if (ownCanonical)
                store.db.exec("begin");
            if (ownLocal)
                store.localDb.exec("begin");
            identity = (store.db.prepare("select id from retrieval_identity").get() as {
                id: string;
            }).id + ":" + statSync(store.paths.databasePath).birthtimeMs;
            store.localDb.prepare("select count(*) from sqlite_master").get();
            await backup(store.db, join(directory, ".code-butler", "memory.sqlite"));
            // Preserve explicit local quality decisions alongside the canonical read snapshot.
            await backup(store.localDb, join(directory, "quality.sqlite"));
        }
        finally {
            if (ownCanonical)
                store.db.exec("rollback");
            if (ownLocal)
                store.localDb.exec("rollback");
        }
        writeFileSync(join(directory, "capture.json"), JSON.stringify({ directory, root, identity, epoch }));
        return { directory, root, identity, epoch };
    }
    catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}
export function publishCapture(capture: Capture) {
    if (capture.epoch !== retrievalEpoch(capture.root))
        throw new Error("Captured memory index was revoked");
    const config = loadProjectConfig(capture.root);
    const store = openMemoryStore(capture.directory, { localDatabasePath: join(capture.directory, "quality.sqlite"), privacyPolicy: createRedactionPolicy(config.privacy) });
    store.init();
    store.paths.rootDir = capture.root;
    store.paths.dataDir = join(capture.root, ".code-butler");
    try {
        return publishRetrieval(store, capture.root, capture.identity, capture.epoch);
    }
    finally {
        store.close();
        rmSync(capture.directory, { recursive: true, force: true });
    }
}
export async function rebuildRetrieval(root: string): Promise<void> {
    const paths = retrievalPaths(root);
    mkdirSync(paths.directory, { recursive: true });
    await withProjectGate(paths.directory, async () => {
        writeFileSync(paths.status, JSON.stringify({ running: true, pid: process.pid, startedAt: new Date().toISOString() }));
        try {
            const capture = await projectOperation(root, async () => {
                const store = openConfiguredMemoryStore(root);
                store.init();
                try {
                    let changedPolicy = !existsSync(paths.database);
                    if (existsSync(paths.database)) {
                        const prior = new DatabaseSync(paths.database, { readOnly: true });
                        try {
                            const p = readPublication(prior);
                            changedPolicy = !p || !publicationPrivacyMatches(root, p);
                        }
                        catch {
                            changedPolicy = true;
                        }
                        finally {
                            prior.close();
                        }
                    }
                    if (changedPolicy) {
                        // Establish current privacy guarantees before the first publication too.
                        const { scrubPrivacy } = await import("../privacy/service.js");
                        scrubPrivacy(store);
                    }
                    const identity = (store.db.prepare("select id from retrieval_identity").get() as {
                        id: string;
                    }).id + ":" + statSync(store.paths.databasePath).birthtimeMs;
                    const sequence = Number((store.db.prepare("select coalesce(max(sequence),0) n from retrieval_changes").get() as {
                        n: number;
                    }).n);
                    try {
                        if (withPublishedIndex(root, (_db, p) => p.format === 3 && p.identity === identity && p.sequence === sequence && p.policy === retrievalPolicy(root)))
                            return undefined;
                    }
                    catch { /* Prepare or repair the derived index. */ }
                    return await captureRetrieval(store);
                }
                finally {
                    store.close();
                }
            });
            if (capture)
                publishCapture(capture);
            else
                refreshPublishedFiles(root);
            const active = retrievalPaths(root).database;
            for (const name of readdirSync(paths.directory).filter(name => /^index(?:-[a-f0-9-]+)?\.sqlite$/.test(name))) {
                const retired = join(paths.directory, name);
                if (retired === active)
                    continue;
                // Windows readers hold the old file until their next request. Retry those later.
                try {
                    rmSync(retired);
                    for (const suffix of ["-wal", "-shm"])
                        rmSync(retired + suffix, { force: true });
                }
                catch { /* Still held by a reader. */ }
            }
            writeFileSync(paths.status, JSON.stringify({ running: false }));
        }
        catch (error) {
            writeFileSync(paths.status, JSON.stringify({ running: false, error: "Memory index refresh failed; the last completed revision remains available." }));
            throw error;
        }
    }, { waitMs: 30 * 60 * 1000 });
}
const pending = new Map<string, Promise<void>>();
const requested = new Map<string, number>();
const children = new Set<ReturnType<typeof spawn>>();
function workerEntry(): string {
    let entry = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
    if (!existsSync(entry))
        entry = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
    return existsSync(entry) ? entry : fileURLToPath(import.meta.url);
}
function workerArguments(entry: string, ...args: string[]): string[] {
    const flags = [...process.execArgv];
    if (entry.endsWith(".ts") && !flags.some(flag => flag.includes("tsx")))
        flags.push("--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href);
    return [...flags, entry, ...args];
}
export async function stopRetrievalWorkers(): Promise<void> {
    await Promise.all([...children].map(child => new Promise<void>(done => {
        if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
        }
        child.once("close", () => done());
        child.kill();
    })));
}
export async function callCanonicalTool(root: string, name: string, input: unknown, clientInfo?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, workerArguments(workerEntry(), "--retrieval-worker", root, "--canonical-tool", name), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        children.add(child);
        child.once("exit", () => children.delete(child));
        child.once("error", () => children.delete(child));
        const chunks: Buffer[] = [];
        let size = 0;
        let errors = 0;
        child.stdout.on("data", chunk => { size += chunk.length; if (name !== "read_memory_source" && size > 8 * 1024 * 1024)
            child.kill();
        else
            chunks.push(chunk); });
        child.stderr.on("data", chunk => { errors += chunk.length; if (errors > 65536)
            child.kill(); });
        child.once("error", reject);
        child.once("exit", code => {
            if (code !== 0)
                return reject(new Error("Canonical memory operation failed"));
            try {
                const reply = JSON.parse(Buffer.concat(chunks).toString());
                if (reply.error)
                    reject(new Error(reply.error));
                else
                    resolve(reply.result);
            }
            catch (error) {
                reject(error);
            }
        });
        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify({ input, clientInfo }));
    });
}
export function requestRetrievalRefresh(root: string, force = false, sync = false): Promise<void> {
    const running = pending.get(root);
    // A mutation may have committed after the running worker captured its snapshot.
    if (running)
        return force ? running.catch(() => { }).then(() => requestRetrievalRefresh(root, true, sync)) : running;
    if (!force && Date.now() - (requested.get(root) ?? 0) < 4000)
        return Promise.resolve();
    requested.set(root, Date.now());
    const promise = new Promise<void>((resolve, reject) => {
        const entry = workerEntry();
        const child = spawn(process.execPath, workerArguments(entry, "--retrieval-worker", root, ...(sync ? ["--ingest"] : [])), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        children.add(child);
        child.once("exit", () => children.delete(child));
        child.once("error", () => children.delete(child));
        let size = 0;
        child.stderr?.on("data", data => { size += data.length; if (size > 65536)
            child.kill(); });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error("Memory index worker failed")));
    }).finally(() => pending.delete(root));
    pending.set(root, promise);
    return promise;
}
export async function runRetrievalWorker(): Promise<void> {
    const root = process.argv[process.argv.indexOf("--retrieval-worker") + 1];
    if (!root)
        throw new Error("Missing retrieval project");
    if (process.argv.includes("--canonical-tool")) {
        const name = process.argv[process.argv.indexOf("--canonical-tool") + 1]!;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > 1024 * 1024)
                throw new Error("Memory request too large");
            chunks.push(Buffer.from(chunk));
        }
        const request = JSON.parse(Buffer.concat(chunks).toString()) as {
            input: unknown;
            clientInfo?: {
                name: string;
                version: string;
            };
        };
        try {
            const result = name === "__cloud_sync" ? await cloudSync(root) :
                name === "__project_setup" ? await ensureAutomaticProjectSetup(root) :
                name === "__enrich_project_summary" ? await enrichLocalProjectSummary(root) : await projectOperation(root, async () => {
                const store = openConfiguredMemoryStore(root);
                store.init();
                try {
                    const handlers = createProjectMemoryToolHandlers(store, { rootDir: root, clientInfo: () => request.clientInfo });
                    if (!Object.hasOwn(handlers, name))
                        throw new Error("Unknown memory operation");
                    return await (Reflect.get(handlers, name) as (input: unknown) => unknown)(request.input);
                }
                finally {
                    store.close();
                }
            });
            process.stdout.write(JSON.stringify({ result }));
        }
        catch (error) {
            process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : "Memory operation failed" }));
        }
        return;
    }
    if (process.argv.includes("--ingest"))
        await projectOperation(root, async () => {
            const store = openConfiguredMemoryStore(root);
            store.init();
            try {
                const { syncProjectMemory } = await import("../sync/service.js");
                await syncProjectMemory(store, loadProjectConfig(root));
            }
            finally {
                store.close();
            }
        });
    await rebuildRetrieval(root);
}
export function scheduleRetrieval(root: string): void { void requestRetrievalRefresh(root).catch(() => { }); }
