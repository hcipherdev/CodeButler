import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { globalConfigDir } from "./config.js";
import { assertOrdinaryProject, globalRulesRoot, isGlobalRulesRoot } from "./rules/identity.js";
import { watcherOwnsProjectGate, withProjectGate } from "./cloud/gate.js";
import { activeForegroundIntent } from "./cloud/foreground.js";
import { localCloudChangeStamp } from "./cloud/client.js";
import { secretBinding } from "./secrets/state.js";
import { pruneEncryptedCaches } from "./cloud/encrypted-coordinator.js";
import { NativeSecurity } from "./cloud/native-security.js";
import { automaticSyncQueue, automaticSyncStatus, requestAutomaticSyncIfAbsent, requestLocalChangeSync } from "./cloud/sync-owner.js";
import { atomicJson, binding, canonicalRoot, readJson, sha256, stateDirectory } from "./cloud/state.js";
import { newRuntimeRecord, processIsLive, registerRuntime, type BuildInfo, type RuntimeRecord } from "./runtime.js";
import { errorOutcome, type OperationOutcome, type OperationStage } from "./cloud/outcome.js";
import { migrateRegisteredCheckouts } from "./cloud/checkout-repair.js";
import { checkoutNeedsRepair } from "./cloud/checkout-path.js";
import { readSyncProgress } from "./cloud/sync-progress.js";

export interface WatchedProject { root: string; registeredAt: string; previousRoots?: string[]; cloud?: { server: string; vaultId: string; projectId: string; projectIdentity?: string } }
export interface WatchPassResult extends OperationOutcome { stages?: Partial<Record<OperationStage, OperationOutcome>> }
export interface WatchRunStatus { root: string; checkedAt: string; ok: boolean; error?: string; outcome?: OperationOutcome["outcome"]; stage?: OperationStage; lastSuccessAt?: string; stages?: WatchPassResult["stages"]; retryCount?: number; nextRetryAt?: number }
export type WatchJobKind = "full" | "cloud";
const MAX_PROJECT_WORKERS = 2;
export const globalWatchDirectory = (): string => join(globalConfigDir(), "watch");
const projectDirectory = (): string => join(globalWatchDirectory(), "projects");
const projectKey = (root: string): string => sha256(root);
function registrationFiles(root: string): string[] {
  if (!existsSync(projectDirectory())) return [];
  return readdirSync(projectDirectory()).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).filter(n => {
    const record = readJson<WatchedProject>(join(projectDirectory(), n));
    if (!record?.root) return false;
    try { return canonicalRoot(record.root) === root; } catch { return resolve(record.root) === root; }
  }).map(n => join(projectDirectory(), n));
}

export function registerWatchedProject(root: string): WatchedProject {
  assertOrdinaryProject(root);
  root = canonicalRoot(root);
  if (!existsSync(join(root, ".code-butler", "config.json"))) throw new Error("Initialize Code Butler in the project before registering it.");
  const path = join(projectDirectory(), `${projectKey(root)}.json`);
  const aliases = registrationFiles(root);
  const current = readJson<WatchedProject>(path) ?? (aliases[0] ? readJson<WatchedProject>(aliases[0]) : undefined);
  if (current?.root === root && existsSync(path)) { const cloud = binding(root); if (cloud && cloud.status !== "connection-repair-required") recordWatchedCloudConnection(root, cloud); return readJson<WatchedProject>(path)!; }
  const previousRoots = [...new Set([...(current?.previousRoots ?? []), ...aliases.flatMap(path => { const previous = readJson<WatchedProject>(path); return previous ? [previous.root, ...(previous.previousRoots ?? [])] : []; })])].filter(path => path !== root);
  const project = { ...current, root, registeredAt: current?.registeredAt ?? new Date().toISOString(), ...(previousRoots.length ? { previousRoots } : {}) };
  atomicJson(path, project);
  for (const alias of aliases) if (alias !== path) unlinkSync(alias);
  const cloud = binding(root); if (cloud && cloud.status !== "connection-repair-required") recordWatchedCloudConnection(root, cloud);
  return readJson<WatchedProject>(path)!;
}

/** Persist the connection independently of the folder so missing checkouts remain visible. */
export function recordWatchedCloudConnection(root: string, state: import("./cloud/state.js").Binding): void {
  root = canonicalRoot(root);
  const path = registrationFiles(root)[0] ?? join(projectDirectory(), `${projectKey(root)}.json`), current = readJson<WatchedProject>(path);
  if (!current) return;
  atomicJson(path, { ...current, cloud: { server: state.server, vaultId: state.vaultId, projectId: state.projectId, ...(state.projectIdentity ? { projectIdentity: state.projectIdentity } : {}) } });
}

export function unregisterWatchedProject(root: string): void {
  try {
    root = canonicalRoot(root);
  } catch {
    // Keep unavailable projects removable from the desktop UI. Registrations are
    // keyed from normalized absolute paths, so the original path still resolves
    // to the same key when the folder has temporarily disappeared.
    root = resolve(root);
  }
  const path = join(projectDirectory(), `${projectKey(root)}.json`);
  for (const file of new Set([path, ...registrationFiles(root)])) try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function listWatchedProjects(): WatchedProject[] {
  if (!existsSync(projectDirectory())) return [];
  return readdirSync(projectDirectory()).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const record = readJson<WatchedProject>(join(projectDirectory(), name));
      if (!record || typeof record.root !== "string" || typeof record.registeredAt !== "string") return [];
      try { return [{ ...record, root: canonicalRoot(record.root) }]; } catch { return [record]; }
    } catch { return []; }
  }).sort((a, b) => a.root.localeCompare(b.root)).filter((record,index,records)=>records.findIndex(candidate=>candidate.root===record.root)===index);
}

export function globalWatchStatus(): { running: boolean; pid?: number; build?: BuildInfo; projects: (WatchedProject & { lastRun?: WatchRunStatus; lastCloudRun?: WatchRunStatus })[] } {
  const runner = readJson<RuntimeRecord>(join(globalWatchDirectory(), "runner.json"));
  let running = false;
  if (runner && Number.isInteger(runner.pid)) {
    running = processIsLive(runner);
  }
  return {
    running, ...(running && runner ? { pid: runner.pid, build: runner.build } : {}),
    projects: listWatchedProjectStatuses()
  };
}

export function listWatchedProjectStatuses(): (WatchedProject & { lastRun?: WatchRunStatus; lastCloudRun?: WatchRunStatus })[] {
  return listWatchedProjects().map(project => {
      const lastRun = readJson<WatchRunStatus>(join(globalWatchDirectory(), "status", `${projectKey(project.root)}.json`));
      const lastCloudRun = readJson<WatchRunStatus>(join(globalWatchDirectory(), "cloud-status", `${projectKey(project.root)}.json`));
      return { ...project, ...(lastRun ? { lastRun } : {}), ...(lastCloudRun ? { lastCloudRun } : {}) };
  });
}

/**
 * Record a cloud sync that succeeded outside the watcher (a reviewed resolve), so the
 * project stops showing the failure that led to it and the watcher drops its backoff.
 */
export function recordCloudRunSuccess(root: string): void {
  const checkedAt = new Date().toISOString();
  const status: WatchRunStatus = { root, checkedAt, ok: true, lastSuccessAt: checkedAt, outcome: "success", stage: "cloud" };
  try { atomicJson(join(globalWatchDirectory(), "cloud-status", `${projectKey(root)}.json`), status); }
  catch { /* The watcher's next run rewrites this status anyway. */ }
}

/** A cloud retry is obsolete once a later success was recorded or the binding synced after it failed. */
function cloudRecoveredSince(root: string, failedAt: number, saved: WatchRunStatus | undefined): boolean {
  if (saved?.ok && Date.parse(saved.checkedAt) > failedAt) return true;
  try {
    const cloud = binding(root);
    return cloud?.status === "synced" && !!cloud.lastSync && Date.parse(cloud.lastSync) > failedAt;
  } catch { return false; }
}

export function requestGlobalWatchStop(): void {
  const runner = readJson<{ token?: string }>(join(globalWatchDirectory(), "runner.json"));
  if (runner?.token) atomicJson(join(globalWatchDirectory(), "stop.json"), { token: runner.token });
}

export interface GlobalWatchOptions {
  cliPath: string;
  intervalSeconds?: number;
  source?: string;
  once?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  runProject?: (root: string, kind: WatchJobKind) => Promise<void | WatchPassResult>;
}

/** One process across all sessions; children isolate project env/provider credentials. */
export async function runGlobalWatch(options: GlobalWatchOptions): Promise<void> {
  const interval = options.intervalSeconds ?? 30;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("Watch interval must be positive");
  const directory = globalWatchDirectory();
  mkdirSync(directory, { recursive: true });
  await withProjectGate(directory, async () => {
    migrateRegisteredCheckouts();
    for (const project of listWatchedProjects()) if (existsSync(join(project.root, ".code-butler", "config.json")) && !checkoutNeedsRepair(project.root)) registerWatchedProject(project.root);
    const runnerPath = join(directory, "runner.json");
    const runtime = newRuntimeRecord("watcher");
    const token = runtime.token;
    const unregister = registerRuntime(runtime);
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    const childOptions = { ...options, signal, runnerToken: token };
    const retries = new Map<string, { count: number; nextAt: number; failedAt: number }>();
    const nextFullAt = new Map<string, number>();
    const nextCloudCheckAt = new Map<string, number>();
    const nextSecretsRunAt = new Map<string, number>();
    const cacheChecked = new Set<string>();
    let nextAutomaticSetupAt = 0;
    const onceRoots = options.once ? listWatchedProjects().map(project => project.root) : [];
    const completedOnce = new Set<string>();
    const active = new Map<string, { kind: WatchJobKind; promise: Promise<void> }>();
    atomicJson(runnerPath, runtime);
    const stopTimer = setInterval(() => {
      try {
        if (readJson<{ token: string }>(join(directory, "stop.json"))?.token === token) stop.abort();
      } catch { /* Retry a temporarily unreadable stop request on the next tick. */ }
    }, 1000);
    try {
      const launch = (root: string, kind: WatchJobKind): void => {
        if (kind === "cloud" && secretBinding(root)?.enabled) nextSecretsRunAt.set(root, Date.now() + 60_000);
        const promise = (async () => {
          const statusPath = join(directory, kind === "cloud" ? "cloud-status" : "status", `${projectKey(root)}.json`);
          const previous = readJson<WatchRunStatus>(statusPath);
          const lastSuccessAt = previous?.lastSuccessAt ?? (previous?.ok ? previous.checkedAt : undefined);
          const status: WatchRunStatus = { root, checkedAt: new Date().toISOString(), ok: false, ...(lastSuccessAt ? { lastSuccessAt } : {}) };
          try {
            if (!existsSync(join(root, ".code-butler", "config.json"))) throw new Error("Project is unavailable or no longer initialized");
            const result = await (options.runProject ?? ((project, job) => runProjectChild(project, job, childOptions)))(root, kind);
            status.outcome = result?.outcome ?? "success";
            status.ok = status.outcome === "success";
            if (result) { status.stage = result.stage; if (result.reason) status.error = result.reason; if (result.stages) status.stages = result.stages; }
          } catch (error) {
            const result = errorOutcome(error, "watcher");
            status.outcome = result.outcome; status.stage = result.stage; status.error = result.reason!;
          }
          status.checkedAt = new Date().toISOString();
          if (status.ok) status.lastSuccessAt = status.checkedAt;
          const retryKey = `${kind}:${root}`;
          if (status.outcome === "deferred" || status.outcome === "failed" && kind === "cloud") {
            const count = (retries.get(retryKey)?.count ?? 0) + 1;
            const base = status.outcome === "deferred" ? 2000 : 10000;
            const limit = status.outcome === "deferred" ? 60000 : 300000;
            const nextAt = Date.now() + Math.min(limit, base * 2 ** Math.min(count - 1, 5)) + Math.floor(Math.random() * 1000);
            retries.set(retryKey, { count, nextAt, failedAt: Date.now() });
            status.retryCount = count; status.nextRetryAt = nextAt;
          } else retries.delete(retryKey);
          if (kind === "full") nextFullAt.set(root, Date.now() + interval * 1000);
          if (options.once) completedOnce.add(root);
          atomicJson(statusPath, status);
          options.log?.(`${status.checkedAt} ${root} (${kind}): ${status.ok ? "updated" : status.error}`);
        })().finally(() => { active.delete(root); });
        active.set(root, { kind, promise });
      };
      while (!signal.aborted) {
        if (!options.once && Date.now() >= nextAutomaticSetupAt) {
          nextAutomaticSetupAt = Date.now() + 60_000;
          try {
            const [{ bootstrapAccount }, { localAccountStatus }] = await Promise.all([import("./desktop/bootstrap.js"), import("./desktop/account.js")]);
            await bootstrapAccount(await localAccountStatus());
          } catch { /* Login, enrollment and connectivity changes are retried without failing local ingestion. */ }
        }
        const roots = options.once ? onceRoots : listWatchedProjects().map(project => project.root);
        const rulesRoot = globalRulesRoot();
        if (!options.once && existsSync(rulesRoot) && binding(rulesRoot)?.enabled) roots.push(rulesRoot);
        const now = Date.now();
        if (!options.once) for (const root of roots) {
          if ((nextCloudCheckAt.get(root) ?? 0) > now) continue;
          nextCloudCheckAt.set(root, now + 60_000);
          try {
            const cloud = binding(root);
            if (!cloud?.enabled || checkoutNeedsRepair(root)) continue;
            if (!cacheChecked.has(root)) {
              cacheChecked.add(root);
              try { await withProjectGate(stateDirectory(root), () => pruneEncryptedCaches(stateDirectory(root), NativeSecurity.forServer(cloud.server))); }
              catch { /* Cache cleanup can retry with the next cloud job. */ }
            }
            const completed = automaticSyncStatus(root);
            // Local changes wait out the publish interval; a remote check meanwhile would publish them anyway.
            if (completed.lastLocalStamp !== localCloudChangeStamp(root)) requestLocalChangeSync(root);
            else if (!automaticSyncQueue(root).pending) requestAutomaticSyncIfAbsent(root, "remote"); // Check for remote revisions.
          } catch { /* A later sweep retries unavailable projects. */ }
        }
        while (active.size < MAX_PROJECT_WORKERS && !signal.aborted) {
          const available = roots.filter(root => !active.has(root) && !activeForegroundIntent(root) && (!options.once || !completedOnce.has(root)));
          const retryAt = (root: string, kind: WatchJobKind): number => {
            const key = `${kind}:${root}`;
            let retry = retries.get(key);
            const saved = !retry || kind === "cloud" ? readJson<WatchRunStatus>(join(directory, kind === "cloud" ? "cloud-status" : "status", `${projectKey(root)}.json`)) : undefined;
            if (!retry && saved?.nextRetryAt && saved.nextRetryAt > now) {
              retry = { count: saved.retryCount ?? 1, nextAt: saved.nextRetryAt, failedAt: Date.parse(saved.checkedAt) };
              retries.set(key, retry);
            }
            if (retry && kind === "cloud" && cloudRecoveredSince(root, retry.failedAt, saved)) { retries.delete(key); return 0; }
            return retry?.nextAt ?? 0;
          };
          const urgent = options.once ? [] : available.flatMap(root => {
            if (!existsSync(join(root, ".code-butler", "config.json")) || retryAt(root, "cloud") > now || checkoutNeedsRepair(root)) return [];
            const queue = automaticSyncQueue(root);
            const secretsDue = secretBinding(root)?.enabled && (nextSecretsRunAt.get(root) ?? 0) <= now;
            const repair = readJson<{ retryAfter?: number }>(join(stateDirectory(root), "catalog-maintenance.json"));
            const catalogDue = repair && (repair.retryAfter ?? 0) <= now;
            return binding(root)?.enabled && queue.pending || secretsDue || catalogDue
              ? [{ root, queuedSince: queue.pending ? queue.queuedSince ?? "" : new Date(now).toISOString() }] : [];
          }).sort((a, b) => Date.parse(a.queuedSince) - Date.parse(b.queuedSince) || a.root.localeCompare(b.root)).map(item => item.root);
          const background = available.filter(root => !isGlobalRulesRoot(root) && (nextFullAt.get(root) ?? 0) <= now && retryAt(root, "full") <= now)
            .sort((a, b) => (nextFullAt.get(a) ?? 0) - (nextFullAt.get(b) ?? 0) || a.localeCompare(b));
          const hasBackgroundWorker = [...active.values()].some(job => job.kind === "full");
          const hasCloudWorker = [...active.values()].some(job => job.kind === "cloud");
          const kind: WatchJobKind | undefined = urgent.length && !hasCloudWorker ? "cloud" : background.length && !hasBackgroundWorker ? "full" : undefined;
          const root = kind === "cloud" ? urgent[0] : kind === "full" ? background[0] : undefined;
          if (!root) break;
          launch(root, kind!);
        }
        if (options.once && active.size === 0 && completedOnce.size === onceRoots.length) break;
        try { await Promise.race([...active.values()].map(job => job.promise).concat(delay(1000, undefined, { signal }))); }
        catch (error) { if (!signal.aborted) throw error; }
      }
      await Promise.allSettled([...active.values()].map(job => job.promise));
    } finally { clearInterval(stopTimer); unlinkSync(runnerPath); unregister(); }
  });
}

/** A pass with no fresh sync progress for this long is presumed stuck. */
const PROJECT_WATCH_IDLE_MS = 10 * 60 * 1000;
/** Even while reporting progress (a large merge or upload), a pass is stopped after this long. */
const PROJECT_WATCH_MAX_MS = 60 * 60 * 1000;
const PROJECT_WATCH_RECHECK_MS = 60 * 1000;
/**
 * Whether a project pass should be stopped. Progress counts only once written after the pass
 * began, so a report left behind by an earlier, stopped worker cannot keep a stuck one alive.
 */
export function projectWatchExpired(startedAt: number, progressAt: number | undefined, now: number): boolean {
  if (now - startedAt >= PROJECT_WATCH_MAX_MS) return true;
  return now - Math.max(startedAt, progressAt ?? 0) >= PROJECT_WATCH_IDLE_MS;
}

function runProjectChild(root: string, kind: WatchJobKind, options: GlobalWatchOptions & { runnerToken: string }): Promise<WatchPassResult> {
  return new Promise((resolve, reject) => {
    const passToken = randomUUID();
    const childArgs = isGlobalRulesRoot(root) ? [options.cliPath, "rules", "sync", "now"] : [options.cliPath, "watch", "--once", ...(kind === "cloud" ? ["--cloud-only"] : []), "--source", options.source ?? "all"];
    const child = spawn(process.execPath, childArgs, {
      cwd: root, env: { ...process.env, CODE_BUTLER_WATCH_TOKEN: passToken, CODE_BUTLER_WATCH_RUNNER_TOKEN: options.runnerToken }, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    let report: WatchPassResult | undefined;
    child.on("message", message => {
      if (message && typeof message === "object" && "type" in message && message.type === "watch-result" && "stage" in message && ["cloud", "ingestion", "summary", "watcher"].includes(String(message.stage)) && "outcome" in message && ["success", "deferred", "failed"].includes(String(message.outcome))) report = message as unknown as WatchPassResult;
    });
    // Bound a stuck project without preventing the remaining projects from syncing.
    let timedOut = false;
    let preempted = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    // A cloud sync that keeps reporting progress is not stuck: stopping it mid-upload wastes the transfer.
    const startedAt = Date.now();
    const expire = () => {
      const progress = readSyncProgress(root), progressAt = progress ? Date.parse(progress.updatedAt) : undefined;
      if (projectWatchExpired(startedAt, Number.isFinite(progressAt) ? progressAt : undefined, Date.now())) { timedOut = true; child.kill(); }
      else timer = setTimeout(expire, PROJECT_WATCH_RECHECK_MS);
    };
    let timer = setTimeout(expire, PROJECT_WATCH_IDLE_MS);
    const foregroundCheck = setInterval(() => {
      if (preempted || !child.pid) return;
      const intent = activeForegroundIntent(root);
      if (!intent || Date.now() - intent.requestedAt < 120_000) return;
      if (!watcherOwnsProjectGate(root, child.pid, passToken)) return;
      preempted = true;
      if (child.connected) child.send({ type: "watch-stop" }, () => {});
      forceStop = setTimeout(() => child.kill(), 10_000);
    }, 1000);
    const abort = () => { if (child.connected) child.send({ type: "watch-stop" }, () => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); clearInterval(foregroundCheck); if (forceStop) clearTimeout(forceStop); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (preempted) resolve({ outcome: "deferred", stage: "watcher", reason: "Foreground AI review took priority; background pass will retry" });
      else if (!timedOut && kind === "cloud" && !report) reject(new Error("Cloud worker exited without a sync result"));
      else if (!timedOut && (code === 0 || code === 75 || code === 1 && report)) resolve(report ?? { outcome: code === 75 ? "deferred" : "success", stage: "watcher", ...(code === 75 ? { reason: "Waiting for another Butler operation" } : {}) });
      else reject(new Error(timedOut ? "Project watch timed out; will retry" : `Project watch exited with code ${code}; see watcher logs`));
    });
  });
}
