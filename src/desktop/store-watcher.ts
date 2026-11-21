import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readProjectOperationStatus, withProjectGate } from "../cloud/gate.js";
import { OperationDeferredError } from "../cloud/outcome.js";
import { atomicJson, readJson } from "../cloud/state.js";
import { globalWatchDirectory, listWatchedProjects, runGlobalWatch, type GlobalWatchOptions } from "../global-watch.js";
import { buildInfo, processIsLive, type RuntimeRecord } from "../runtime.js";
import {
  storeLauncher, storeStartup, storeWatcherHandoffPath, storeWatcherJournalPath, storeWatcherTransitionDirectory, type StoreWatcherHandoff
} from "../store-runtime.js";
import {
  changeWindowsWatcherRegistration, readWindowsWatcherRegistration, restartWindowsWatcherRegistration, type WindowsWatcherRegistration
} from "../watch-service.js";
import { managedWatcherState, verifyStandaloneWindowsWatcher } from "./runtime-installer.js";

interface HandoffJournal {
  version: 1;
  registration: WindowsWatcherRegistration;
  runner?: RuntimeRecord;
}

const runnerPath = () => join(globalWatchDirectory(), "runner.json");
const stopPath = () => join(globalWatchDirectory(), "stop.json");
const writeStatus = (state: StoreWatcherHandoff["state"], detail?: string) =>
  atomicJson(storeWatcherHandoffPath(), { state, ...(detail ? { detail } : {}) });
const liveRunner = () => {
  const runner = readJson<RuntimeRecord>(runnerPath());
  return runner && processIsLive(runner) ? runner : undefined;
};

const windows = {
  inspect: readWindowsWatcherRegistration,
  verify: verifyStandaloneWindowsWatcher,
  verifyProcess: managedWatcherState,
  change: changeWindowsWatcherRegistration,
  restart: restartWindowsWatcherRegistration,
  startupEnabled: () => storeStartup("status", join(dirname(process.execPath), "..", "..", "code-butler.exe")).installed,
  watch: runGlobalWatch,
  projects: listWatchedProjects
};

const samePath = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function verifyRunner(runner: RuntimeRecord, registration: WindowsWatcherRegistration, platform: typeof windows): void {
  const roots = platform.verify(registration.nodePath, registration.cliPath);
  if (runner.build.distribution === "store" || !samePath(runner.executable, registration.nodePath) ||
      !samePath(runner.entrypoint, registration.cliPath) || platform.verifyProcess(runner, roots) !== "managed" ||
      !/^[a-f0-9-]{36}$/i.test(runner.token)) throw new Error("The running watcher could not be verified as the registered standalone watcher.");
}

async function waitForExit(runner: RuntimeRecord, signal?: AbortSignal): Promise<void> {
  while (processIsLive(runner)) {
    signal?.throwIfAborted();
    await delay(500, undefined, signal ? { signal } : {});
  }
}

async function rollback(journal: HandoffJournal, platform: typeof windows): Promise<void> {
  if (journal.version !== 1) throw new Error("The saved watcher handoff is not supported.");
  const { registration, runner } = journal;
  platform.verify(registration.nodePath, registration.cliPath);
  platform.change(registration, true);
  const stopRequested = runner && readJson<{ token: string }>(stopPath())?.token === runner.token;
  if (runner && stopRequested) {
    // A stop already consumed by the worker cannot be undone. Let it exit before restarting.
    await waitForExit(runner);
  }
  if (runner && !liveRunner()) platform.restart(registration);
  if (stopRequested) {
    rmSync(stopPath(), { force: true });
  }
  rmSync(storeWatcherJournalPath(), { force: true });
  writeStatus("rolled-back", "Standalone watcher startup was restored. Open Code Butler again to retry.");
}

async function withTransition(work: () => Promise<void>): Promise<void> {
  const directory = storeWatcherTransitionDirectory();
  mkdirSync(directory, { recursive: true });
  let entered = false;
  try {
    await withProjectGate(directory, () => { entered = true; return work(); },
      { waitMs: 0, name: "Switch Code Butler watcher" });
  } catch (error) {
    // Desktop activation and Windows sign-in can arrive together.
    if (entered || !(error instanceof OperationDeferredError)) throw error;
  }
}

export async function recoverStoreWatcher(): Promise<void> {
  if (!storeLauncher() || buildInfo.distribution !== "store" || !readJson(storeWatcherJournalPath())) return;
  await withTransition(async () => {
    const prior = readJson<HandoffJournal>(storeWatcherJournalPath());
    if (prior) await rollback(prior, windows);
  });
}

export async function runStoreWatcher(options: GlobalWatchOptions, platform = windows): Promise<void> {
  let watcher: Promise<void> | undefined;
  let startNormally = false;
  await withTransition(async () => {
    try {
      const prior = readJson<HandoffJournal>(storeWatcherJournalPath());
      if (prior) await rollback(prior, platform);
      if (!platform.startupEnabled()) return;

      const runner = liveRunner();
      if (runner?.build.distribution === "store") return;
      const registration = platform.inspect();
      if (!registration || registration.launcherInactive || (!registration.startup && !registration.tasks.some(task => task.enabled))) {
        if (runner) throw new Error("The active watcher has no enabled standalone startup entry that Code Butler can take over.");
        startNormally = true;
        return;
      }

      platform.verify(registration.nodePath, registration.cliPath);
      if (runner) verifyRunner(runner, registration, platform);
      const owner = readProjectOperationStatus(globalWatchDirectory());
      if (owner && owner.pid !== runner?.pid) throw new Error("Another process owns the global watcher lock.");
      const journal: HandoffJournal = { version: 1, registration, ...(runner ? { runner } : {}) };
      atomicJson(storeWatcherJournalPath(), journal);
      try {
        writeStatus("waiting", "Waiting for the standalone watcher to finish.");
        platform.change(registration, false);
        if (runner && processIsLive(runner)) {
          verifyRunner(runner, registration, platform);
          atomicJson(stopPath(), { token: runner.token });
          await waitForExit(runner, options.signal);
        }
        writeStatus("starting");
        await new Promise<void>((resolve, reject) => {
          watcher = platform.watch({
            ...options,
            onReady: replacement => {
              if (replacement.pid !== process.pid || replacement.build.buildId !== buildInfo.buildId || !platform.startupEnabled()) {
                throw new Error("The packaged watcher could not be verified or its startup task was disabled.");
              }
              platform.projects();
              rmSync(storeWatcherJournalPath(), { force: true });
              resolve();
            }
          });
          void watcher.then(() => reject(new Error("The packaged watcher exited before it was ready.")), reject);
        });
      } catch (error) {
        await rollback(journal, platform);
        throw error;
      }
    } catch (error) {
      const status = readJson<StoreWatcherHandoff>(storeWatcherHandoffPath());
      if (status?.state !== "rolled-back") writeStatus("blocked", error instanceof Error ? error.message : "Watcher handoff failed.");
      throw error;
    }
  });
  if (watcher) {
    rmSync(storeWatcherHandoffPath(), { force: true });
    await watcher;
  }
  else if (startNormally) {
    try {
      await platform.watch({ ...options, onReady: () => rmSync(storeWatcherHandoffPath(), { force: true }) });
    } catch (error) {
      if (!(error instanceof OperationDeferredError) || liveRunner()?.build.distribution !== "store") throw error;
    }
  }
}
