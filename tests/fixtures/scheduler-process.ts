import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// The same fixture can exercise source modules or an installed distribution.
const base = process.env.BUTLER_TEST_RUNTIME;
const moduleUrl = (name: string) => base ? pathToFileURL(join(base, `${name}.js`)).href : new URL(`../../src/${name}.ts`, import.meta.url).href;
const { startServer } = await import(moduleUrl("server"));
const { startCloudScheduler } = await import(moduleUrl("cloud/client"));
const { binding } = await import(moduleUrl("cloud/state"));
const { registerWatchedProject, runGlobalWatch } = await import(moduleUrl("global-watch"));
const root = process.env.BUTLER_TEST_PROJECT!;
const events = join(root, "events.jsonl");
const event = (name: string) => appendFileSync(events, `${JSON.stringify({ name, pid: process.pid, role: process.argv[2], time: Date.now() })}\n`);
const sync = async () => {
  const sentinel = join(root, "publication.lock");
  if (existsSync(sentinel)) {
    const oldPid = Number(readFileSync(sentinel, "utf8"));
    try { process.kill(oldPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(sentinel); }
  }
  let handle: number;
  try { handle = openSync(sentinel, "wx"); }
  catch (error) { event("overlap"); throw error; }
  writeFileSync(handle, String(process.pid));
  event("start");
  try { await delay(300); event("end"); return binding(root); }
  finally { closeSync(handle); unlinkSync(sentinel); }
};
if (process.argv[2] === "mcp") {
  await startServer({ rootDir: root, cloudSchedulerOptions: { sync, pollMs: 500, tickMs: 100, settleMs: 100 } });
} else {
  registerWatchedProject(root);
  const controller = new AbortController();
  process.on("message", message => { if (message === "stop") controller.abort(); });
  await runGlobalWatch({ cliPath: "unused", intervalSeconds: 0.2, signal: controller.signal, runProject: async () => {
    const runner = JSON.parse(readFileSync(join(process.env.CODE_BUTLER_HOME!, "watch", "runner.json"), "utf8"));
    // What the global watcher gives its project children: a pass token, and the runner token that lets a
    // watcher-role scheduler take sync ownership while the runner is live.
    process.env.CODE_BUTLER_WATCH_TOKEN = runner.token;
    process.env.CODE_BUTLER_WATCH_RUNNER_TOKEN = runner.token;
    const scheduler = startCloudScheduler(root, () => {}, { role: "watcher", automatic: false, sync });
    try { const result = await scheduler.run(); if (result.outcome === "success") event("pass"); return result; }
    finally { await scheduler(); }
  } });
  process.disconnect?.();
}
